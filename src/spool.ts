/** JSONL message spools: one append-only file per project. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ensureDirs, spoolPath } from "./paths.ts";

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
