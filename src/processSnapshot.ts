/** Daemon-published process evidence for sandboxed coordination clients. */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { claims } from "./claims.ts";
import { PROCESS_SNAPSHOT_PATH } from "./paths.ts";
import {
  type ProcessInfo,
  type ProcessScan,
  scanProcesses,
} from "./registry.ts";
import { work } from "./work.ts";

export interface ProcessSnapshot {
  version: 1;
  generatedAt: number;
  generatedBy: number;
  pids: number[];
  reliable: boolean;
  processes: Array<ProcessInfo & { pid: number }>;
}

export interface ProcessSnapshotReport {
  source: "process-snapshot";
  fresh: boolean;
  generatedAt: number | null;
  evidence: ProcessScan;
}

export const PROCESS_SNAPSHOT_TTL_MS = 30_000;

export function coordinationOwnerPids(): number[] {
  return [
    ...claims.listAll().map((record) => record.owner.pid),
    ...work.listAll().map((record) => record.owner.pid),
  ].filter((pid): pid is number => pid !== undefined);
}

export function writeProcessSnapshot(
  nowMs = Date.now(),
  path = PROCESS_SNAPSHOT_PATH,
  pids = coordinationOwnerPids(),
  scan = scanProcesses(pids),
): ProcessSnapshot {
  const uniquePids = [...new Set(pids)].sort((a, b) => a - b);
  const snapshot: ProcessSnapshot = {
    version: 1,
    generatedAt: nowMs,
    generatedBy: process.pid,
    pids: uniquePids,
    reliable: scan.reliable,
    processes: [...scan.processes].map(([pid, info]) => ({ pid, ...info })),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 1));
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return snapshot;
}

function parseSnapshot(path: string): ProcessSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ProcessSnapshot>;
    if (
      value.version !== 1 ||
      typeof value.generatedAt !== "number" ||
      !Array.isArray(value.pids) ||
      typeof value.reliable !== "boolean" ||
      !Array.isArray(value.processes)
    ) {
      return undefined;
    }
    return value as ProcessSnapshot;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Return evidence only when a fresh, reliable daemon scan covered every pid. */
export function readProcessSnapshot(
  pids: number[],
  nowMs = Date.now(),
  path = PROCESS_SNAPSHOT_PATH,
): ProcessSnapshotReport {
  const snapshot = parseSnapshot(path);
  const wanted = new Set(pids);
  const covered = snapshot
    ? [...wanted].every((pid) => snapshot.pids.includes(pid))
    : false;
  const fresh = Boolean(
    snapshot &&
      nowMs - snapshot.generatedAt <= PROCESS_SNAPSHOT_TTL_MS &&
      snapshot.reliable &&
      covered,
  );
  const processes = new Map<number, ProcessInfo>();
  if (fresh && snapshot) {
    for (const { pid, start, command } of snapshot.processes) {
      if (wanted.has(pid)) processes.set(pid, { start, command });
    }
  }
  return {
    source: "process-snapshot",
    fresh,
    generatedAt: snapshot?.generatedAt ?? null,
    evidence: { processes, reliable: fresh },
  };
}

/** Prefer a direct scan, falling back to fresh daemon evidence in sandboxes. */
export function coordinationProcessEvidence(pids: number[]): ProcessScan {
  const direct = scanProcesses(pids);
  return direct.reliable ? direct : readProcessSnapshot(pids).evidence;
}
