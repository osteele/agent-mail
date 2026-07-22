/** JSONL message spools: one append-only file per project. */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_DIR,
  ensureDirs,
  legacyReadStatePath,
  readStatePath,
  spoolPath,
} from "./paths.ts";

export interface Message {
  id?: string;
  ts: string; // ISO 8601
  from: string; // sender label: "weft", a project slug, "cli", ...
  project: string; // canonical target project directory
  message: string;
  replyTo?: string; // id of the message this is a reply to
  threadId?: string; // root message id; groups a back-and-forth conversation
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

/** Whether a message in a shared project spool is visible to one session.
 *
 * A project inbox is shared by every session in that directory. Session-local
 * views hide messages authored by the same session, unless the sender
 * explicitly addressed the message back to itself. */
export function messageVisibleToSession(
  msg: Message,
  sessionId: string,
): boolean {
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
  return path;
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
  ensureDirs();
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

export function markMessagesRead(project: string, ids: string[]): number {
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
