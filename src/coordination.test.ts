import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimStore } from "./claims.ts";
import { listCoordination, ownerStatus } from "./coordination.ts";
import type { Registration } from "./registry.ts";
import { WorkStore } from "./work.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("owner status distinguishes live, offline, and manual owners", () => {
  const registration: Registration = {
    cwd: "/project",
    pid: 42,
    sessionId: "session-a",
    started: "2026-08-12T00:00:00.000Z",
  };
  expect(
    ownerStatus(
      { id: "session-a", label: "A", sessionId: "session-a", pid: 42 },
      [registration],
    ),
  ).toBe("live");
  expect(
    ownerStatus(
      { id: "session-a", label: "A", sessionId: "session-a", pid: 43 },
      [registration],
    ),
  ).toBe("offline");
  expect(ownerStatus({ id: "cli", label: "operator" }, [registration])).toBe(
    "manual",
  );
});

test("coordination conditions preserve the different resource lifecycles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-coordination-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  const claimStore = new ClaimStore(join(root, "claims"));
  const workStore = new WorkStore(join(root, "work"));
  const owner = { id: "operator", label: "operator" };
  const experiment = claimStore.claimExperiment(project, notebook, owner);
  claimStore.claimPath(project, join(project, "future.md"), "file", owner);
  workStore.acquire(
    project,
    {
      type: "research-plan",
      key: "plan",
      sourcePath: join(project, "missing-plan.md"),
    },
    owner,
  );

  let entries = listCoordination({
    project,
    registrations: [],
    claimStore,
    workStore,
  });
  expect(entries.find((entry) => entry.id === experiment.id)?.condition).toBe(
    "awaiting-materialization",
  );
  expect(entries.find((entry) => entry.kind === "path-claim")?.condition).toBe(
    "target-absent",
  );
  expect(entries.find((entry) => entry.kind === "work")?.condition).toBe(
    "source-missing",
  );

  writeFileSync(join(notebook, "experiments", "EXP-001-pilot.md"), "");
  entries = listCoordination({
    project,
    registrations: [],
    claimStore,
    workStore,
  });
  expect(entries.find((entry) => entry.id === experiment.id)?.condition).toBe(
    "materialized",
  );
});
