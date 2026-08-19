import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WEFT_JOBS_SNAPSHOT_TTL_MS,
  countBySession,
  readWeftJobsSnapshot,
  weftJobsForSession,
  writeWeftJobsSnapshot,
} from "./weftJobs.ts";

function tempSnapshotPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agent-mail-weft-")),
    "weft-jobs.json",
  );
}

test("counts unprocessed jobs per submitter session", () => {
  const counts = countBySession([
    { id: 1, submitter_session: "a" },
    { id: 2, submitter_session: "b" },
    { id: 3, submitter_session: "a" },
  ]);
  expect(counts.bySession).toEqual({ a: 2, b: 1 });
  expect(counts.total).toBe(3);
});

test("an unattributable job is counted, not dropped", () => {
  // weft returns an empty string for a job it cannot attribute, and an older
  // weft omits the key. Dropping either would report a smaller total, which
  // reads as "fewer jobs" rather than "cannot tell".
  const counts = countBySession([
    { id: 1, submitter_session: "" },
    { id: 2 },
    { id: 3, submitter_session: "a" },
  ]);
  expect(counts.bySession).toEqual({ "": 2, a: 1 });
  expect(counts.total).toBe(3);
});

test("non-array input yields no counts rather than throwing", () => {
  expect(countBySession(null)).toEqual({ bySession: {}, total: 0 });
  expect(countBySession({ jobs: [] })).toEqual({ bySession: {}, total: 0 });
});

test("a published snapshot round-trips", () => {
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    const read = readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path);
    expect(read?.bySession).toEqual({ a: 2 });
    expect(read?.generatedAt).toBe(1000);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a snapshot past its TTL is not served", () => {
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    const later = 1000 + WEFT_JOBS_SNAPSHOT_TTL_MS + 1;
    expect(readWeftJobsSnapshot(later, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
      undefined,
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test("a missing or malformed snapshot reads as unknown, never throws", () => {
  const path = tempSnapshotPath();
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  writeFileSync(path, "{ not json");
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  writeFileSync(path, JSON.stringify({ version: 99, generatedAt: 1000 }));
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  rmSync(path, { force: true });
});

test("no jobs for a session is a different answer from no snapshot", () => {
  // A stopped daemon must not report an all-clear. 0 says weft was asked;
  // undefined says nobody knows.
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    expect(weftJobsForSession("a", 1000, path)).toBe(2);
    expect(weftJobsForSession("quiet-session", 1000, path)).toBe(0);
    const later = 1000 + WEFT_JOBS_SNAPSHOT_TTL_MS + 1;
    expect(weftJobsForSession("a", later, path)).toBe(undefined);
    expect(weftJobsForSession(undefined, 1000, path)).toBe(undefined);
  } finally {
    rmSync(path, { force: true });
  }
});
