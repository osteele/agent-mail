/** Low-latency presence reads.
 *
 * The only expensive part of `listLive()` is the process scan that verifies
 * each registration's pid still belongs to the process that registered it.
 * Everything downstream — parsing the registry, reading Claude's session meta,
 * deriving names — is sub-millisecond. So this caches the scan, not the render:
 * the daemon periodically writes the pid-verified live set, and readers on a
 * latency budget use that instead of scanning processes themselves.
 *
 * Two invariants keep the cache honest:
 *
 * - **It is a presentation cache, never a routing input.** A snapshot freezes a
 *   liveness verdict for its TTL, so a session that just exited can still
 *   appear. `send_mail`, `list_sessions`, and both dashboards keep calling
 *   `listLive()` directly; only decorative surfaces read from here.
 * - **It stores raw registrations, never derived text.** Nothing in the file
 *   depends on config, which is why the daemon tick needs no SIGHUP coupling.
 *   If it ever starts carrying names or aliases, that changes.
 *
 * Readers degrade rather than fail: a missing, malformed, or stale snapshot
 * falls back to a project-scoped scan, so this works with the daemon stopped.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { PRESENCE_SNAPSHOT_PATH, canonicalProject } from "./paths.ts";
import { type Registration, listLive, listLiveInProject } from "./registry.ts";
import {
  type ClaudeSessionMeta,
  isStaleSession,
  lastActivityMs,
  sessionDisplayName,
} from "./sessions.ts";

export interface PresenceSnapshot {
  version: 1;
  /** Epoch ms the scan ran. In-band rather than the file's mtime: mtime is
   * destroyed by backup restores and `cp -p`, and a torn write carries a fresh
   * one, so it is exactly wrong as a freshness signal. */
  generatedAt: number;
  /** Writing daemon's pid — provenance when a stale file needs explaining. */
  generatedBy: number;
  sessions: Registration[];
}

/** Non-mutating view exposed by `agent-mail listeners --no-sync --json`.
 *
 * `fresh: false` deliberately carries no sessions. Consumers that use this
 * for advisory routing must fail closed rather than treating an old process
 * verdict as proof that a recipient can still receive a message. */
export interface ListenerSnapshot {
  version: 1;
  source: "presence-snapshot";
  fresh: boolean;
  generatedAt: number | null;
  sessions: Registration[];
}

const SNAPSHOT_VERSION = 1;

/** Three times the daemon's 10s tick: tolerates a missed beat without letting
 * a dead session linger long enough to matter on a decorative surface. */
export const PRESENCE_SNAPSHOT_TTL_MS = 30_000;

/** Recompute the live set and publish it. Daemon-only writer.
 *
 * Published via temp file + rename so a reader never sees a half-written file.
 * (The registry itself deliberately does not do this — `listLive` prunes
 * whatever fails to parse — but a pruning reader and a caching reader want
 * opposite failure modes.) */
export function writePresenceSnapshot(
  nowMs = Date.now(),
  path = PRESENCE_SNAPSHOT_PATH,
  sessions?: Registration[],
): PresenceSnapshot {
  const snapshot: PresenceSnapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: nowMs,
    generatedBy: process.pid,
    sessions: sessions ?? listLive(),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, matches the current version, and is
 * younger than `maxAgeMs`; otherwise undefined. Never throws — a status line
 * that crashes is worse than one that falls back. */
export function readPresenceSnapshot(
  nowMs = Date.now(),
  maxAgeMs = PRESENCE_SNAPSHOT_TTL_MS,
  path = PRESENCE_SNAPSHOT_PATH,
): PresenceSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  const snapshot = parsed as Partial<PresenceSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return undefined;
  if (!Array.isArray(snapshot.sessions)) return undefined;
  if (typeof snapshot.generatedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.generatedAt)) return undefined;
  if (nowMs - snapshot.generatedAt > maxAgeMs) return undefined;
  return snapshot as PresenceSnapshot;
}

/** Read the daemon's fresh presence snapshot without scanning processes,
 * pruning registry files, or falling back to another source. */
export function readListenerSnapshot(
  project?: string,
  nowMs = Date.now(),
  path = PRESENCE_SNAPSHOT_PATH,
): ListenerSnapshot {
  const snapshot = readPresenceSnapshot(nowMs, PRESENCE_SNAPSHOT_TTL_MS, path);
  const canon = project ? canonicalProject(project) : undefined;
  return {
    version: 1,
    source: "presence-snapshot",
    fresh: snapshot !== undefined,
    generatedAt: snapshot?.generatedAt ?? null,
    sessions:
      snapshot?.sessions.filter(
        (registration) =>
          canon === undefined || canonicalProject(registration.cwd) === canon,
      ) ?? [],
  };
}

/** Live registrations sharing `project`, from a fresh snapshot when there is
 * one and a project-scoped scan otherwise.
 *
 * The fallback must stay project-scoped. A global `listLive()` here would run
 * inside the status-line script, and Claude Code cancels a status-line command
 * when the next update arrives — a cancelled script drops the whole line, not
 * just this field. */
export function liveInProject(
  project: string,
  nowMs = Date.now(),
): Registration[] {
  const canon = canonicalProject(project);
  const snapshot = readPresenceSnapshot(nowMs);
  if (!snapshot) return listLiveInProject(canon);
  // Snapshot entries are raw registrations, so they carry the same pre-move cwd
  // spellings the registry does; canonicalize here too.
  return snapshot.sessions.filter((r) => canonicalProject(r.cwd) === canon);
}

/** Live, non-stale sessions other than `sessionId`, from a set already scoped
 * to one project. Pure: no filesystem, no clock. */
export function peersInProject(
  sessions: Registration[],
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  nowMs: number,
): Registration[] {
  const present = sessions.filter((r) => {
    const m = r.sessionId ? meta.get(r.sessionId) : undefined;
    return !isStaleSession(m?.status, lastActivityMs(r, m), nowMs);
  });
  const self = sessionId
    ? present.find((r) => r.sessionId === sessionId)
    : undefined;
  if (self) return present.filter((r) => r !== self);
  // No entry matches this session id. Happens after `/clear`: Claude mints a new
  // session id without respawning MCP servers, so the registry still holds the
  // old one. Assume one of these entries is us and discount it — erring toward
  // hiding the name is right, since the name only earns its space when it
  // disambiguates.
  return present.slice(0, Math.max(0, present.length - 1));
}

/** The session's display name, whether or not anyone shares the project.
 *
 * This used to be gated on having a peer, on the theory that a name earns its
 * width only when it disambiguates. That was wrong about what the name is for:
 * agents in *other* projects address this session by this name, so it is the
 * session's identity even when it is alone in its own directory, and a name
 * that appears and disappears as peers come and go is worse than one that is
 * simply always there. Peer count is a separate, independently useful fact —
 * see `peersInProject`. Pure: no filesystem, no clock. */
export function statusLineName(
  project: string,
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
): string {
  if (!sessionId) return "";
  return sessionDisplayName(sessionId, meta.get(sessionId), project);
}
