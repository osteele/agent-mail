import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-lock-"));
  temporaryDirectories.push(root);
  return root;
}

function makeStaleLock(lockPath: string): void {
  mkdirSync(lockPath);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
}

interface LockLogEntry {
  pid: number;
  start: number;
  end: number;
}

function readLog(logPath: string): LockLogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LockLogEntry);
}

function holderScriptSrc(): string {
  const lockModule = join(process.cwd(), "src", "lock.ts");
  return `
    import { writeFileSync } from "node:fs";
    import { withFileLock } from ${JSON.stringify(lockModule)};
    const [lockPath, logPath, holdMs, waitMs] = process.argv.slice(2);
    const start = Date.now();
    withFileLock(lockPath, () => {
      const end = Date.now();
      const entry = JSON.stringify({ pid: process.pid, start, end }) + "\\n";
      writeFileSync(logPath, entry, { flag: "a" });
      Bun.sleepSync(Number(holdMs));
    }, { waitMs: Number(waitMs) });
  `;
}

function spawnHolder(
  root: string,
  lockPath: string,
  logPath: string,
  holdMs: number,
  waitMs: number,
): { subprocess: ReturnType<typeof Bun.spawn>; scriptPath: string } {
  const scriptPath = join(root, "holder.ts");
  writeFileSync(scriptPath, holderScriptSrc());
  const subprocess = Bun.spawn(
    ["bun", scriptPath, lockPath, logPath, String(holdMs), String(waitMs)],
    { cwd: process.cwd(), stdout: "ignore", stderr: "ignore" },
  );
  return { subprocess, scriptPath };
}

test("acquiring a lock writes owner identity into the directory", () => {
  const root = makeRoot();
  const lockPath = join(root, "lock");
  const owner = { label: "test-owner", pid: 12345 };

  withFileLock(
    lockPath,
    () => {
      const identity = JSON.parse(
        readFileSync(join(lockPath, "owner.json"), "utf8"),
      );
      expect(identity).toEqual(owner);
    },
    { owner },
  );
});

test("a held lock blocks waiters until released", async () => {
  const root = makeRoot();
  const lockPath = join(root, "lock");
  const logPath = join(root, "log");

  // Child holds the lock for 200 ms.
  const holder = spawnHolder(root, lockPath, logPath, 200, 2_000);
  // Wait until the holder has definitely acquired.
  while (readLog(logPath).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Parent can acquire after the child releases.
  withFileLock(lockPath, () => {
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].end).toBeLessThan(Date.now());
  });

  await holder.subprocess.exited;
});

test("a waiter with a short timeout throws when the lock is held", async () => {
  const root = makeRoot();
  const lockPath = join(root, "lock");
  const logPath = join(root, "log");

  const holder = spawnHolder(root, lockPath, logPath, 500, 2_000);
  // Wait until the holder has acquired.
  while (readLog(logPath).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(() =>
    withFileLock(
      lockPath,
      () => {
        throw new Error("should not enter");
      },
      { waitMs: 50 },
    ),
  ).toThrow("timed out waiting for lock");

  await holder.subprocess.exited;
});

test("two concurrent breakers of a stale lock never overlap", async () => {
  const root = makeRoot();
  const lockPath = join(root, "lock");
  const logPath = join(root, "log");
  makeStaleLock(lockPath);

  // Both contenders use a short wait and hold for 150 ms. With the unsafe
  // rmdir-based break, both could enter; with atomic rename, at most one is
  // inside at any moment (the loser times out before the winner releases).
  const a = spawnHolder(root, lockPath, logPath, 150, 50);
  const b = spawnHolder(root, lockPath, logPath, 150, 50);

  await Promise.all([a.subprocess.exited, b.subprocess.exited]);

  const log = readLog(logPath);
  // Verify no overlapping intervals.
  for (let i = 0; i < log.length; i++) {
    for (let j = i + 1; j < log.length; j++) {
      const overlap = log[i].start < log[j].end && log[j].start < log[i].end;
      expect(overlap).toBe(false);
    }
  }
});
