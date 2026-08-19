/** Unprocessed weft job counts, cached for the status line.
 *
 * `weft list jobs` takes seconds: it starts a Go binary and queries a local
 * SQLite file, and a measurement at 1-minute load 11 put it at a 3.6s median.
 * Claude Code cancels a status-line script that exceeds roughly 300ms, and a
 * cancelled script drops the whole line rather than one field, so the query
 * can never happen on the read path. The daemon runs it on a slow cadence and
 * publishes counts; the status line reads the file.
 *
 * The same two invariants as `presence.ts`, for the same reasons:
 *
 * - **A presentation cache, never a routing input.** These counts are stale by
 *   construction. Nothing that decides delivery or coordination may read them.
 * - **Raw counts, never derived text.** The file holds a count per submitter
 *   session id and nothing that depends on config, so the refresh needs no
 *   SIGHUP coupling.
 *
 * Readers degrade to showing nothing. A missing, malformed, or stale snapshot
 * never falls back to running weft inline, which would reintroduce the very
 * latency this exists to avoid.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { WEFT_JOBS_SNAPSHOT_PATH } from "./paths.ts";

export interface WeftJobsSnapshot {
  version: 1;
  /** Epoch ms the query ran. In-band rather than the file's mtime, which a
   * backup restore or `cp -p` destroys and a torn write refreshes. */
  generatedAt: number;
  /** Writing process's pid, for explaining a stale file. */
  generatedBy: number;
  /** Unprocessed jobs per submitter session id. The empty-string key holds
   * jobs weft could not attribute to a session, which is a normal value and
   * not an error. */
  bySession: Record<string, number>;
  total: number;
}

const SNAPSHOT_VERSION = 1;

/** How often the daemon refreshes. Deliberately far slower than the daemon's
 * 10s tick: a multi-second subprocess every 10 seconds is a background job
 * that occupies a core on a machine that already reaches load 100. */
export const WEFT_JOBS_REFRESH_MS = 60_000;

/** Three refresh intervals, matching how `presence.ts` sizes its own TTL
 * against its tick: one missed refresh is tolerated, a stopped daemon is not. */
export const WEFT_JOBS_SNAPSHOT_TTL_MS = 3 * WEFT_JOBS_REFRESH_MS;

/** Count unprocessed jobs per submitter session.
 *
 * Pure, so the bucketing is testable without spawning weft. Rows missing the
 * key are counted as unattributable rather than dropped: an older weft omits
 * the field entirely, and silently reporting a smaller total would read as
 * "no jobs" instead of "cannot tell". */
export function countBySession(rows: unknown): {
  bySession: Record<string, number>;
  total: number;
} {
  const bySession: Record<string, number> = {};
  if (!Array.isArray(rows)) return { bySession, total: 0 };
  for (const row of rows) {
    const value =
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>).submitter_session
        : undefined;
    const key = typeof value === "string" ? value : "";
    bySession[key] = (bySession[key] ?? 0) + 1;
  }
  return { bySession, total: rows.length };
}

/** Publish a snapshot. Temp file plus rename, so a reader on a latency budget
 * never parses a half-written file. */
export function writeWeftJobsSnapshot(
  counts: { bySession: Record<string, number>; total: number },
  nowMs = Date.now(),
  path = WEFT_JOBS_SNAPSHOT_PATH,
): WeftJobsSnapshot {
  const snapshot: WeftJobsSnapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: nowMs,
    generatedBy: process.pid,
    bySession: counts.bySession,
    total: counts.total,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, matches the version, and is younger than
 * `maxAgeMs`. Never throws: a status line that crashes is worse than one that
 * shows one fewer field. */
export function readWeftJobsSnapshot(
  nowMs = Date.now(),
  maxAgeMs = WEFT_JOBS_SNAPSHOT_TTL_MS,
  path = WEFT_JOBS_SNAPSHOT_PATH,
): WeftJobsSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  const snapshot = parsed as Partial<WeftJobsSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return undefined;
  if (typeof snapshot.generatedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.generatedAt)) return undefined;
  if (typeof snapshot.total !== "number") return undefined;
  if (typeof snapshot.bySession !== "object" || snapshot.bySession === null) {
    return undefined;
  }
  if (nowMs - snapshot.generatedAt > maxAgeMs) return undefined;
  return snapshot as WeftJobsSnapshot;
}

/** Unprocessed jobs submitted by one session, or undefined when there is no
 * usable snapshot.
 *
 * Undefined and 0 are different answers and the status line renders them
 * differently: 0 means weft was asked and this session has nothing pending,
 * undefined means nobody knows. Collapsing them would let a stopped daemon
 * report an all-clear. */
export function weftJobsForSession(
  sessionId: string | undefined,
  nowMs = Date.now(),
  path = WEFT_JOBS_SNAPSHOT_PATH,
): number | undefined {
  if (!sessionId) return undefined;
  const snapshot = readWeftJobsSnapshot(nowMs, WEFT_JOBS_SNAPSHOT_TTL_MS, path);
  if (!snapshot) return undefined;
  return snapshot.bySession[sessionId] ?? 0;
}
