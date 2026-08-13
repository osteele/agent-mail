/** Registry of live channel servers: which sessions are listening, where. */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  REGISTRY_DIR,
  canonicalProject,
  ensureDirs,
  projectSlug,
} from "./paths.ts";
import { assignedGeneratedSessionName } from "./sessions.ts";

export interface Registration {
  cwd: string;
  pid: number; // channel-server process; dies with the host session
  procStart?: string; // `ps lstart` of that process at register time — a pid
  // alone is not an identity (pids are recycled; a dead session once read as
  // live for 10 days because a system daemon had inherited its pid)

  sessionId?: string; // host session id (Claude Code's; a random uuid under Codex)
  name?: string; // session name snapshot at register time; NOT used for display
  // (may be stale on rename, or a legacy synthetic id) — display re-derives from
  // the live Claude name or a pronounceable alias off the session id

  client?: string; // host client from MCP clientInfo: "claude-code", "codex", ...
  capabilities?: SessionCapabilities;
  muted?: boolean; // channel push paused; messages still spool and flush on unmute
  inboundPolicy?: InboundPolicy;
  lastSeen?: string; // ISO 8601; stamped on each tool call the session makes
  lastInboxPoll?: string; // ISO 8601; check_inbox specifically, not generic activity
  started: string; // ISO 8601
}

export type InboundPolicy = "accept" | "hold" | "refuse";

export interface SessionCapabilities {
  tools: boolean;
  inboxPoll: boolean;
  channelPush: boolean;
  claims: boolean;
  workLeases: boolean;
  receipts: boolean;
  nativePeerMessaging: boolean;
}

export interface ProcessInfo {
  start: string; // lstart tokens joined with single spaces
  command: string;
}

/** Parse one `ps -o pid=,lstart=,command=` output line. lstart is five tokens
 * ("Sat Aug  1 10:48:00 2026"); everything after is the command line. Exported
 * for tests. */
export function parsePsLine(
  line: string,
): { pid: number; info: ProcessInfo } | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 7) return undefined;
  const pid = Number(tokens[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    info: {
      start: tokens.slice(1, 6).join(" "),
      command: tokens.slice(6).join(" "),
    },
  };
}

/** How many pids are worth querying one at a time before one whole-table scan
 * is cheaper. 12 × ~4 ms ≈ the ~24 ms flat cost of `ps -ww -A`. */
const PS_LOOP_MAX = 12;

/** Inspect processes: start time + command per pid; a pid absent from the
 * result is not running.
 *
 * Never issue a multi-row `-p` query. macOS `ps` takes a slow path the moment
 * a `-p` query matches two or more processes — one matched row is ~4 ms, two
 * are ~260 ms, and that cost is flat in the number of pids asked for and
 * independent of the `-o` fields, while a whole-table `ps -A` is only ~24 ms
 * (measured on Darwin 24.6). So loop single-pid queries for small sets and take
 * one table scan for large ones. On Linux the batched form is fine and the loop
 * costs a few ms per pid, so this stays unconditional rather than platform-gated.
 *
 * `-ww` is load-bearing, not cosmetic: without it `ps` truncates the command
 * column, and `isCurrentProcess` falls back to matching that column for legacy
 * entries with no recorded `procStart` — truncation would silently prune a live
 * session.
 *
 * `ps` exits nonzero when a listed pid is gone but still reports the live ones,
 * so the exit status is ignored. */
export function processInfo(pids: number[]): Map<number, ProcessInfo> {
  const map = new Map<number, ProcessInfo>();
  const wanted = new Set(pids);
  if (wanted.size === 0) return map;
  const queries =
    wanted.size <= PS_LOOP_MAX
      ? [...wanted].map((pid) => ["-ww", "-p", String(pid)])
      : [["-ww", "-A"]];
  for (const query of queries) {
    const res = spawnSync("ps", [...query, "-o", "pid=,lstart=,command="], {
      encoding: "utf8",
    });
    for (const line of (res.stdout ?? "").split("\n")) {
      const parsed = parsePsLine(line);
      if (parsed && wanted.has(parsed.pid)) map.set(parsed.pid, parsed.info);
    }
  }
  return map;
}

function entryPath(cwd: string, pid: number): string {
  return join(REGISTRY_DIR, `${projectSlug(cwd)}-${pid}.json`);
}

/** Before assigning the new naming scheme, bank the syllable names of every
 * session already in the registry. Assignments are per session id and survive
 * unregister/restart; stale entries are included so an old session resumed
 * after the upgrade keeps the name its user already saw. */
function preserveRegisteredSessionNames(): void {
  for (const file of readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith(".json")) continue;
    let entry: Registration;
    try {
      entry = JSON.parse(
        readFileSync(join(REGISTRY_DIR, file), "utf8"),
      ) as Registration;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Corrupt registry entries are pruned by listLive; a concurrently
        // removed entry needs no migration.
        continue;
      }
      throw error;
    }
    if (entry.sessionId) assignedGeneratedSessionName(entry.sessionId, true);
  }
}

export function register(
  cwd: string,
  pid: number,
  sessionId?: string,
  name?: string,
  client?: string,
  capabilities?: SessionCapabilities,
  defaultInboundPolicy: InboundPolicy = "accept",
): string {
  ensureDirs();
  preserveRegisteredSessionNames();
  if (sessionId) assignedGeneratedSessionName(sessionId);
  const path = entryPath(cwd, pid);
  // Preserve state set before this re-register: the original start time (the
  // post-initialize re-register adds the client once the handshake reveals it),
  // any mute toggled during the brief startup window, and the last-seen stamp.
  let started = new Date().toISOString();
  let muted: boolean | undefined;
  let lastSeen: string | undefined;
  let lastInboxPoll: string | undefined;
  let procStart: string | undefined;
  let inboundPolicy = defaultInboundPolicy;
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as Registration;
      if (typeof prev.started === "string") started = prev.started;
      if (typeof prev.muted === "boolean") muted = prev.muted;
      if (typeof prev.lastSeen === "string") lastSeen = prev.lastSeen;
      if (typeof prev.lastInboxPoll === "string") {
        lastInboxPoll = prev.lastInboxPoll;
      }
      if (typeof prev.procStart === "string") procStart = prev.procStart;
      if (
        prev.inboundPolicy === "accept" ||
        prev.inboundPolicy === "hold" ||
        prev.inboundPolicy === "refuse"
      ) {
        inboundPolicy = prev.inboundPolicy;
      }
    } catch {
      // corrupt prior entry; keep the fresh timestamp
    }
  }
  procStart ??= processInfo([pid]).get(pid)?.start;
  const entry: Registration = {
    cwd,
    pid,
    ...(procStart ? { procStart } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    ...(client ? { client } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(muted !== undefined ? { muted } : {}),
    inboundPolicy,
    ...(lastSeen ? { lastSeen } : {}),
    ...(lastInboxPoll ? { lastInboxPoll } : {}),
    started,
  };
  writeFileSync(path, JSON.stringify(entry, null, 1));
  return path;
}

/** Set how one session handles new deliveries. Held messages remain in the
 * receipt log and are released when the policy returns to accept. */
export function setInboundPolicy(
  cwd: string,
  pid: number,
  policy: InboundPolicy,
): boolean {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return false;
  let entry: Registration;
  try {
    entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
  } catch {
    return false;
  }
  entry.inboundPolicy = policy;
  writeFileSync(path, JSON.stringify(entry, null, 1));
  return true;
}

export function inboundPolicy(cwd: string, pid: number): InboundPolicy {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return "accept";
  try {
    const policy = (JSON.parse(readFileSync(path, "utf8")) as Registration)
      .inboundPolicy;
    return policy === "hold" || policy === "refuse" ? policy : "accept";
  } catch {
    return "accept";
  }
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

/** Stamp a session's last-seen time (called on each tool call it serves).
 * No-op if the entry is missing or corrupt. */
export function touch(cwd: string, pid: number): void {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return;
  let entry: Registration;
  try {
    entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
  } catch {
    return;
  }
  entry.lastSeen = new Date().toISOString();
  writeFileSync(path, JSON.stringify(entry, null, 1));
}

/** Stamp an explicit inbox check separately from generic MCP activity.
 * Poll-only clients cannot receive an alert, so recent `lastSeen` is not
 * evidence that they will discover newly spooled mail. */
export function touchInboxPoll(cwd: string, pid: number): void {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return;
  let entry: Registration;
  try {
    entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
  } catch {
    return;
  }
  const now = new Date().toISOString();
  entry.lastSeen = now;
  entry.lastInboxPoll = now;
  writeFileSync(path, JSON.stringify(entry, null, 1));
}

export function unregister(cwd: string, pid: number): void {
  const path = entryPath(cwd, pid);
  if (existsSync(path)) rmSync(path);
}

/** Whether the pid still belongs to the process that registered: same start
 * time when the entry recorded one, else (legacy entries) a command line that
 * looks like a channel server. A bare pid-exists check is not enough — recycled
 * pids otherwise keep dead entries alive indefinitely. */
function isCurrentProcess(
  entry: Registration,
  info: ProcessInfo | undefined,
): boolean {
  if (!info) return false;
  if (entry.procStart) return entry.procStart === info.start;
  return /agent-mail|channel\.ts/.test(info.command);
}

/** Read and parse registry files, pruning any that no longer parse. `keep`
 * narrows the set before the process scan, which is the expensive step. */
function readEntries(
  keep?: (entry: Registration) => boolean,
): { path: string; entry: Registration }[] {
  ensureDirs();
  const entries: { path: string; entry: Registration }[] = [];
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
    if (!keep || keep(entry)) entries.push({ path, entry });
  }
  return entries;
}

/** Keep the entries whose process is still the one that registered; prune the
 * rest. `bankLegacyNames` is upgrade bookkeeping and belongs only to the global
 * sweep — a scoped read stays a pure read. */
function verifyLive(
  entries: { path: string; entry: Registration }[],
  bankLegacyNames: boolean,
): Registration[] {
  const procs = processInfo(entries.map((e) => e.entry.pid));
  const out: Registration[] = [];
  for (const { path, entry } of entries) {
    if (isCurrentProcess(entry, procs.get(entry.pid))) {
      if (bankLegacyNames && entry.sessionId)
        assignedGeneratedSessionName(entry.sessionId, true);
      out.push(entry);
    } else {
      rmSync(path);
    }
  }
  return out;
}

/** List live registrations, pruning entries whose process has exited or whose
 * pid has been recycled by an unrelated process. */
export function listLive(): Registration[] {
  return verifyLive(readEntries(), true);
}

/** Live registrations for one project. Same pruning semantics as `listLive`,
 * but only this project's entries are inspected — the difference between
 * scanning every registered process and scanning the handful that share a
 * directory, which matters to callers on a latency budget.
 *
 * Canonicalize at read time rather than trusting the stored `cwd`: entries
 * written before a directory move still carry the old spelling (this repo has
 * live entries under both `code/utils/agent-mail` and
 * `code/agent-tools/agent-mail`, one a symlink to the other), and comparing raw
 * strings silently splits one project in two. */
export function listLiveInProject(project: string): Registration[] {
  const canon = canonicalProject(project);
  return verifyLive(
    readEntries((entry) => canonicalProject(entry.cwd) === canon),
    false,
  );
}
