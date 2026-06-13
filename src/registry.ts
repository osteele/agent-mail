/** Registry of live channel servers: which sessions are listening, where. */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REGISTRY_DIR, ensureDirs, projectSlug } from "./paths.ts";

export interface Registration {
  cwd: string;
  pid: number; // channel-server process; dies with the Claude Code session
  sessionId?: string; // Claude Code session UUID, when known
  name?: string; // session name snapshot at register time (may go stale on rename)
  started: string; // ISO 8601
}

function entryPath(cwd: string, pid: number): string {
  return join(REGISTRY_DIR, `${projectSlug(cwd)}-${pid}.json`);
}

export function register(
  cwd: string,
  pid: number,
  sessionId?: string,
  name?: string,
): string {
  ensureDirs();
  const path = entryPath(cwd, pid);
  const entry: Registration = {
    cwd,
    pid,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    started: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(entry, null, 1));
  return path;
}

export function unregister(cwd: string, pid: number): void {
  const path = entryPath(cwd, pid);
  if (existsSync(path)) rmSync(path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** List live registrations, pruning entries whose process has exited. */
export function listLive(): Registration[] {
  ensureDirs();
  const out: Registration[] = [];
  for (const name of readdirSync(REGISTRY_DIR)) {
    if (!name.endsWith(".json")) continue;
    const path = join(REGISTRY_DIR, name);
    let entry: Registration;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
    } catch {
      rmSync(path);
      continue;
    }
    if (alive(entry.pid)) {
      out.push(entry);
    } else {
      rmSync(path);
    }
  }
  return out;
}
