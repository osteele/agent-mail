/** JSONL message spools: one append-only file per project. */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_DIR,
  ensureDirs,
  legacyReadStatePath,
  readStatePath,
  receiptPath,
  spoolPath,
} from "./paths.ts";

export type MessageOriginKind = "agent" | "automation" | "human";

/** Provenance is descriptive and never conveys user authority. Receivers must
 * apply their own permission rules to work requested by any message. */
export interface MessageOrigin {
  kind: MessageOriginKind;
  transport: "mcp" | "cli" | "http" | "native-audit" | "internal";
  client?: string;
  sessionId?: string;
  authority: "untrusted";
}

export interface Message {
  id?: string;
  ts: string; // ISO 8601
  from: string; // sender label: "weft", a project slug, "cli", ...
  project: string; // canonical target project directory
  message: string;
  replyTo?: string; // id of the message this is a reply to
  threadId?: string; // root message id; groups a back-and-forth conversation
  /** Audit records appear in dashboards but are never delivered to an inbox. */
  delivery?: "mail" | "audit";
  origin?: MessageOrigin;
  /** Caller-supplied retry key. A repeated key is accepted without re-appending. */
  idempotencyKey?: string;
  /** Token minted by the sender for one delivery attempt, never reused — unlike
   * `idempotencyKey`, which a caller reuses deliberately across retries. It
   * exists so a fallback append can tell a message this very attempt already
   * got into the spool (via the daemon, whose reply then went missing) from a
   * genuine duplicate. Set by `withAttemptKey`; not part of the public API. */
  attemptKey?: string;
  /** ISO timestamp after which channel delivery is skipped. */
  expiresAt?: string;
  /** Per-message Slack routing. Undefined preserves the configured default. */
  slackEcho?: boolean;
  meta?: Record<string, string>;
}

export interface StoredMessage extends Message {
  id: string;
  read: boolean;
}

export interface ReadMessagesOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export type ReceiptStatus =
  | "spooled"
  | "held"
  | "pushed"
  | "read"
  | "refused"
  | "expired";

export interface DeliveryReceipt {
  messageId: string;
  project: string;
  ts: string;
  status: ReceiptStatus;
  sessionId?: string;
  detail?: string;
}

export interface AdmissionOptions {
  duplicateWindowSeconds: number;
  messageRateLimitPerMinute: number;
  defaultMessageTtlSeconds: number | null;
}

/** Which rule rejected an append as a duplicate.
 *
 * `attempt-key` is the sender colliding with itself: the token is minted per
 * attempt and never reused, so a match proves this attempt's own message is
 * already in the spool — it was delivered, not suppressed. The other two are
 * genuine duplicates. Callers must keep the cases apart; conflating them tells
 * a sender its message was dropped when it was delivered. */
export type DuplicateReason = "attempt-key" | "idempotency-key" | "signature";

export type AdmissionResult =
  | { status: "spooled"; id: string; path: string }
  | { status: "duplicate"; id: string; reason: DuplicateReason }
  | { status: "rate_limited"; retryAfterSeconds: number };

function messageTime(msg: Message): number {
  const time = Date.parse(msg.ts);
  return Number.isFinite(time) ? time : 0;
}

function senderKey(msg: Message): string {
  return msg.origin?.sessionId ?? msg.meta?.sessionId ?? msg.from;
}

function duplicateSignature(msg: Message): string {
  return [
    senderKey(msg),
    msg.project,
    msg.meta?.toSession ?? "*",
    msg.delivery ?? "mail",
    msg.message,
  ].join("\u0000");
}

/** Decide whether a message should be appended. Exported for deterministic
 * tests; the filesystem wrapper below applies it to recent spool entries. */
export function admissionDecision(
  recent: Message[],
  incoming: Message,
  options: AdmissionOptions,
  nowMs = Date.now(),
):
  | { status: "accept" }
  | { status: "duplicate"; id: string; reason: DuplicateReason }
  | { status: "rate_limited"; retryAfterSeconds: number } {
  // Checked first, and separately from idempotencyKey: this is the sender
  // finding its own already-stored message, which is a success, not a repeat.
  if (incoming.attemptKey) {
    const own = [...recent]
      .reverse()
      .find((msg) => msg.attemptKey === incoming.attemptKey);
    if (own?.id) {
      return { status: "duplicate", id: own.id, reason: "attempt-key" };
    }
  }

  if (incoming.idempotencyKey) {
    const prior = [...recent]
      .reverse()
      .find((msg) => msg.idempotencyKey === incoming.idempotencyKey);
    if (prior?.id) {
      return { status: "duplicate", id: prior.id, reason: "idempotency-key" };
    }
  }

  if (options.duplicateWindowSeconds > 0) {
    const duplicateCutoff = nowMs - options.duplicateWindowSeconds * 1000;
    const signature = duplicateSignature(incoming);
    const duplicate = [...recent]
      .reverse()
      .find(
        (msg) =>
          messageTime(msg) >= duplicateCutoff &&
          duplicateSignature(msg) === signature,
      );
    if (duplicate?.id) {
      return { status: "duplicate", id: duplicate.id, reason: "signature" };
    }
  }

  const minuteCutoff = nowMs - 60_000;
  const sender = senderKey(incoming);
  const inWindow = recent.filter(
    (msg) => senderKey(msg) === sender && messageTime(msg) >= minuteCutoff,
  );
  if (
    options.messageRateLimitPerMinute > 0 &&
    inWindow.length >= options.messageRateLimitPerMinute
  ) {
    const oldest = Math.min(...inWindow.map(messageTime));
    return {
      status: "rate_limited",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + 60_000 - nowMs) / 1000),
      ),
    };
  }
  return { status: "accept" };
}

export function isExpired(msg: Message, nowMs = Date.now()): boolean {
  if (!msg.expiresAt) return false;
  const expiry = Date.parse(msg.expiresAt);
  return Number.isFinite(expiry) && expiry <= nowMs;
}

/** Whether this message participates in the normal Slack mirror. */
export function shouldEchoMessageToSlack(msg: Message): boolean {
  return msg.slackEcho !== false;
}

/** Whether a message in a shared project spool is visible to one session.
 *
 * A project inbox is shared by every session in that directory. Session-local
 * views hide messages authored by the same session, unless the sender
 * explicitly addressed the message back to itself. */
export function messageVisibleToSession(
  msg: Message,
  sessionId: string,
): boolean {
  if (msg.delivery === "audit" || isExpired(msg)) return false;
  if (msg.meta?.toSession && msg.meta.toSession !== sessionId) return false;
  return msg.meta?.sessionId !== sessionId || msg.meta?.toSession === sessionId;
}

export function appendMessage(msg: Message): string {
  ensureDirs();
  const path = spoolPath(msg.project);
  const id = msg.id ?? randomUUID();
  // Every message carries a threadId so a conversation can be grouped uniformly:
  // a reply inherits its parent's thread (resolved upstream, where the parent is
  // visible), and a root message is its own thread.
  const threadId = msg.threadId ?? msg.replyTo ?? id;
  const withId = { ...msg, id, threadId };
  appendFileSync(path, `${JSON.stringify(withId)}\n`);
  appendReceipt(msg.project, {
    messageId: id,
    project: msg.project,
    ts: new Date().toISOString(),
    status: "spooled",
  });
  return path;
}

function recentMessages(project: string, limit = 1000): Message[] {
  const path = spoolPath(project);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: Message[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as Message);
    } catch {
      // Admission remains available if one prior line was torn.
    }
  }
  return out;
}

/** Best-effort idempotency and loop protection around the append-only spool.
 * The daemon serializes normal calls; direct fallback appenders can still race,
 * but O_APPEND keeps the log intact and downstream message ids remain unique. */
export function appendMessageGuarded(
  msg: Message,
  options: AdmissionOptions,
  nowMs = Date.now(),
): AdmissionResult {
  const id = msg.id ?? randomUUID();
  const prepared: Message = {
    ...msg,
    id,
    ...(msg.expiresAt || options.defaultMessageTtlSeconds === null
      ? {}
      : {
          expiresAt: new Date(
            nowMs + options.defaultMessageTtlSeconds * 1000,
          ).toISOString(),
        }),
  };
  const decision = admissionDecision(
    recentMessages(msg.project),
    prepared,
    options,
    nowMs,
  );
  if (decision.status !== "accept") return decision;
  return { status: "spooled", id, path: appendMessage(prepared) };
}

export function appendReceipt(
  project: string,
  receipt: Omit<DeliveryReceipt, "project"> | DeliveryReceipt,
): void {
  ensureDirs();
  const normalized: DeliveryReceipt = { ...receipt, project };
  appendFileSync(receiptPath(project), `${JSON.stringify(normalized)}\n`);
}

/** Find a message's receipts wherever they live, with the owning project.
 *
 * Receipts are keyed to the *recipient's* project, so a sender querying its own
 * project for a message it sent always finds nothing — and an empty result reads
 * as "dropped". Three sessions drew that wrong conclusion in one day, one of
 * them mid-incident, so locating receipts must not depend on the caller
 * happening to sit in the recipient's directory. */
export function findReceipts(
  messageId: string,
  fromProject?: string,
): { project: string; receipts: DeliveryReceipt[] } | undefined {
  const ordered = fromProject
    ? [fromProject, ...knownProjects().filter((p) => p !== fromProject)]
    : knownProjects();
  for (const project of ordered) {
    const receipts = readReceipts(project, messageId);
    if (receipts.length) return { project, receipts };
  }
  return undefined;
}

export function readReceipts(
  project: string,
  messageId?: string,
): DeliveryReceipt[] {
  const path = receiptPath(project);
  if (!existsSync(path)) return [];
  const out: DeliveryReceipt[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const receipt = JSON.parse(line) as DeliveryReceipt;
      if (!messageId || receipt.messageId === messageId) out.push(receipt);
    } catch {
      // A torn receipt does not hide later state transitions.
    }
  }
  return out;
}

export function hasReceipt(
  receipts: DeliveryReceipt[],
  messageId: string,
  sessionId: string,
  statuses: ReceiptStatus[],
): boolean {
  return receipts.some(
    (receipt) =>
      receipt.messageId === messageId &&
      receipt.sessionId === sessionId &&
      statuses.includes(receipt.status),
  );
}

/** Distinct project directories that have ever received mail. */
export function knownProjects(): string[] {
  ensureDirs();
  const projects = new Set<string>();
  for (const name of readdirSync(INBOX_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const firstLine = readFileSync(join(INBOX_DIR, name), "utf8").split(
      "\n",
      1,
    )[0];
    try {
      const msg = JSON.parse(firstLine) as Message;
      if (msg.project) projects.add(msg.project);
    } catch {
      // corrupt first line; skip this spool for discovery purposes
    }
  }
  return [...projects];
}

function fallbackMessageId(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

/** Read ids = the union of the append-only log plus any legacy JSON file. The
 * union is order- and duplicate-insensitive, which is what makes concurrent
 * appends safe: two markers can't clobber each other's marks. */
function readIds(project: string): Set<string> {
  const ids = new Set<string>();
  const path = readStatePath(project);
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const id = line.trim();
      if (id) ids.add(id);
    }
  }
  const legacy = legacyReadStatePath(project);
  if (existsSync(legacy)) {
    try {
      const doc = JSON.parse(readFileSync(legacy, "utf8")) as {
        read?: unknown;
      };
      if (Array.isArray(doc.read)) {
        for (const id of doc.read) if (typeof id === "string") ids.add(id);
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return ids;
}

/** Append read ids to the log. A single appendFileSync is one O_APPEND write,
 * atomic against concurrent appenders for the small batches we mark at a time;
 * duplicates (two processes marking the same id) are harmless — readIds dedups. */
function appendReadIds(project: string, ids: string[]): void {
  if (ids.length === 0) return;
  ensureDirs();
  appendFileSync(readStatePath(project), ids.map((id) => `${id}\n`).join(""));
}

export function readMessages(
  project: string,
  options: number | ReadMessagesOptions = 20,
): StoredMessage[] {
  const limit = typeof options === "number" ? options : (options.limit ?? 20);
  const unreadOnly =
    typeof options === "number" ? false : (options.unreadOnly ?? false);
  const path = spoolPath(project);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const read = readIds(project);
  const out: StoredMessage[] = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Message;
      const id = msg.id ?? fallbackMessageId(line);
      const stored = { ...msg, id, read: read.has(id) };
      if (!unreadOnly || !stored.read) out.push(stored);
    } catch {
      // Skip corrupt lines rather than failing the whole read; the spool is
      // append-only and a torn write should not poison the inbox.
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** Every message across every project spool, oldest-first. For dashboards and
 * cross-project aggregation; per-project read-state is applied. */
export function readAllMessages(): StoredMessage[] {
  if (!existsSync(INBOX_DIR)) return [];
  const out: StoredMessage[] = [];
  for (const name of readdirSync(INBOX_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(INBOX_DIR, name), "utf8")
      .split("\n")
      .filter(Boolean);
    const readByProject = new Map<string, Set<string>>();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Message;
        const id = msg.id ?? fallbackMessageId(line);
        let read = readByProject.get(msg.project);
        if (!read) {
          read = readIds(msg.project);
          readByProject.set(msg.project, read);
        }
        out.push({ ...msg, id, read: read.has(id) });
      } catch {
        // Skip corrupt/torn lines, consistent with readMessages.
      }
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

export function markMessagesRead(
  project: string,
  ids: string[],
  sessionId?: string,
): number {
  const available = new Set(
    readMessages(project, { limit: 0 }).map((msg) => msg.id),
  );
  const read = readIds(project);
  const toAdd: string[] = [];
  for (const id of ids) {
    // The read check only avoids redundant appends; correctness comes from the
    // union on read, not from this snapshot, so a concurrent marker can't race us.
    if (!available.has(id) || read.has(id)) continue;
    read.add(id);
    toAdd.push(id);
  }
  appendReadIds(project, toAdd);
  if (sessionId) {
    const ts = new Date().toISOString();
    for (const messageId of ids.filter((id) => available.has(id))) {
      appendReceipt(project, {
        messageId,
        ts,
        status: "read",
        sessionId,
      });
    }
  }
  return toAdd.length;
}

export function markAllMessagesRead(project: string): number {
  const unread = readMessages(project, { limit: 0, unreadOnly: true });
  appendReadIds(
    project,
    unread.map((msg) => msg.id),
  );
  return unread.length;
}
