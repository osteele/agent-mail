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
  pid: number; // channel-server process; dies with the host session
  sessionId?: string; // host session id (Claude Code's; a random uuid under Codex)
  name?: string; // session name snapshot at register time (may go stale on rename)
  client?: string; // host client from MCP clientInfo: "claude-code", "codex", ...
  muted?: boolean; // channel push paused; messages still spool and flush on unmute
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
  client?: string,
): string {
  ensureDirs();
  const path = entryPath(cwd, pid);
  // Preserve state set before this re-register: the original start time (the
  // post-initialize re-register adds the client once the handshake reveals it)
  // and any mute toggled during the brief startup window.
  let started = new Date().toISOString();
  let muted: boolean | undefined;
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as Registration;
      if (typeof prev.started === "string") started = prev.started;
      if (typeof prev.muted === "boolean") muted = prev.muted;
    } catch {
      // corrupt prior entry; keep the fresh timestamp
    }
  }
  const entry: Registration = {
    cwd,
    pid,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    ...(client ? { client } : {}),
    ...(muted !== undefined ? { muted } : {}),
    started,
  };
  writeFileSync(path, JSON.stringify(entry, null, 1));
  return path;
}

/** Toggle a session's channel-push mute. Returns false if no entry exists (the
 * session isn't/no longer listening). */
export function setMuted(cwd: string, pid: number, muted: boolean): boolean {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return false;
  let entry: Registration;
  try {
    entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
  } catch {
    return false;
  }
  entry.muted = muted;
  writeFileSync(path, JSON.stringify(entry, null, 1));
  return true;
}

/** Whether a session's channel push is muted. Fail-open (deliver) on a missing
 * or corrupt entry. */
export function isMuted(cwd: string, pid: number): boolean {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return false;
  try {
    return (
      (JSON.parse(readFileSync(path, "utf8")) as Registration).muted === true
    );
  } catch {
    return false;
  }
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
