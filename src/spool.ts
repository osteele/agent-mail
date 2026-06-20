/** JSONL message spools: one append-only file per project. */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { INBOX_DIR, ensureDirs, readStatePath, spoolPath } from "./paths.ts";

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

function readIds(project: string): Set<string> {
  const path = readStatePath(project);
  if (!existsSync(path)) return new Set();
  let doc: { read?: unknown };
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as { read?: unknown };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return new Set();
  }
  if (!Array.isArray(doc.read)) return new Set();
  return new Set(doc.read.filter((id): id is string => typeof id === "string"));
}

function writeIds(project: string, ids: Set<string>): void {
  ensureDirs();
  const path = readStatePath(project);
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify({ read: [...ids].sort() }, null, 1)}\n`,
  );
  renameSync(tmpPath, path);
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

export function markMessagesRead(project: string, ids: string[]): number {
  const messages = readMessages(project, { limit: 0 });
  const available = new Set(messages.map((msg) => msg.id));
  const read = readIds(project);
  let changed = 0;
  for (const id of ids) {
    if (!available.has(id) || read.has(id)) continue;
    read.add(id);
    changed++;
  }
  if (changed > 0) writeIds(project, read);
  return changed;
}

export function markAllMessagesRead(project: string): number {
  const messages = readMessages(project, { limit: 0, unreadOnly: true });
  const read = readIds(project);
  for (const msg of messages) read.add(msg.id);
  if (messages.length > 0) writeIds(project, read);
  return messages.length;
}
