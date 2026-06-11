/** JSONL message spools: one append-only file per project. */

import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX_DIR, ensureDirs, spoolPath } from "./paths.ts";

export interface Message {
  ts: string; // ISO 8601
  from: string; // sender label: "weft", a project slug, "cli", ...
  project: string; // canonical target project directory
  message: string;
  meta?: Record<string, string>;
}

export function appendMessage(msg: Message): string {
  ensureDirs();
  const path = spoolPath(msg.project);
  appendFileSync(path, `${JSON.stringify(msg)}\n`);
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

export function readMessages(project: string, limit = 20): Message[] {
  const path = spoolPath(project);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  const out: Message[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as Message);
    } catch {
      // Skip corrupt lines rather than failing the whole read; the spool is
      // append-only and a torn write should not poison the inbox.
    }
  }
  return out;
}
