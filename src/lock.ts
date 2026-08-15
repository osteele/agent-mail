/** Filesystem mutex with atomic stale-lock breaking and optional owner identity.
 *
 * The lock is a directory. Acquisition is `mkdirSync(lockPath)`; because
 * directory creation is atomic, exactly one caller wins. A process can die
 * between `mkdirSync` and release, leaving the directory behind. Waiters break
 * stale locks by *renaming* the directory to a unique stale path rather than
 * removing it directly; `renameSync` is atomic, so if two waiters both see the
 * same stale lock, exactly one break succeeds and the other loops.
 *
 * The holder never refreshes the lock mtime. Callers must therefore keep the
 * critical section well under `staleMs`; the default 30 s is generous for the
 * tiny synchronous mutations in this project.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface LockOwner {
  label: string;
  pid?: number;
  procStart?: string;
  sessionId?: string;
  instanceId?: string;
}

export interface WithFileLockOptions {
  owner?: LockOwner;
  staleMs?: number;
  waitMs?: number;
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  options: WithFileLockOptions = {},
): T {
  const staleMs = options.staleMs ?? 30_000;
  const waitMs = options.waitMs ?? 2_000;
  const deadline = Date.now() + waitMs;

  mkdirSync(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;

      let mtime: number;
      try {
        mtime = statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (isCode(statError, "ENOENT")) continue;
        throw statError;
      }

      if (Date.now() - mtime > staleMs) {
        const stalePath = `${lockPath}.stale.${randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (renameError) {
          if (isCode(renameError, "ENOENT")) continue;
          throw renameError;
        }
        try {
          rmSync(stalePath, { recursive: true, force: true });
        } catch (removeError) {
          if (!isCode(removeError, "ENOENT")) throw removeError;
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockPath}`);
      }

      Bun.sleepSync(10);
    }
  }

  try {
    if (options.owner) {
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify(options.owner, undefined, 2),
        { flag: "wx" },
      );
    }
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
