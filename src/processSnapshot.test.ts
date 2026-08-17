import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProcessSnapshot,
  writeProcessSnapshot,
} from "./processSnapshot.ts";

test("process snapshots prove absent covered pids without a local scan", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-process-snapshot-"));
  const path = join(root, "processes.json");
  try {
    writeProcessSnapshot(10_000, path, [42, 43], {
      reliable: true,
      processes: new Map([
        [42, { start: "Thu Aug 13 07:00:00 2026", command: "agent-mail" }],
      ]),
    });
    const report = readProcessSnapshot([42, 43], 20_000, path);
    expect(report.fresh).toBe(true);
    expect(report.evidence.reliable).toBe(true);
    expect(report.evidence.processes.has(42)).toBe(true);
    expect(report.evidence.processes.has(43)).toBe(false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("process snapshots fail closed when stale or missing requested coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-process-stale-"));
  const path = join(root, "processes.json");
  try {
    writeProcessSnapshot(10_000, path, [42], {
      reliable: true,
      processes: new Map(),
    });
    expect(readProcessSnapshot([43], 20_000, path).fresh).toBe(false);
    expect(readProcessSnapshot([42], 50_001, path).fresh).toBe(false);
  } finally {
    rmSync(root, { recursive: true });
  }
});
