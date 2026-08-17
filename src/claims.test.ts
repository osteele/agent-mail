import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ClaimConflictError,
  type ClaimOwner,
  ClaimStore,
  pathClaimTargets,
} from "./claims.ts";
import { projectSlug } from "./paths.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): {
  project: string;
  notebook: string;
  claimRoot: string;
  store: ClaimStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-claims-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  const claimRoot = join(root, "claims");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  return { project, notebook, claimRoot, store: new ClaimStore(claimRoot) };
}

const ownerA: ClaimOwner = { id: "agent-a", label: "agent A" };
const ownerB: ClaimOwner = { id: "agent-b", label: "agent B" };

test("experiment claims atomically advance past files and active claims", () => {
  const { project, notebook, store } = fixture();
  writeFileSync(join(notebook, "experiments", "EXP-002-baseline.md"), "");

  const first = store.claimExperiment(project, notebook, ownerA);
  const second = store.claimExperiment(project, notebook, ownerB);

  expect(first.experimentId).toBe("EXP-003");
  expect(second.experimentId).toBe("EXP-004");
  expect(store.list(project).map((claim) => claim.id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("directory claims conflict with ancestor and descendant path claims", () => {
  const { project, store } = fixture();
  const source = join(project, "src");
  mkdirSync(source);
  store.claimPath(project, source, "directory", ownerA);

  expect(() =>
    store.claimPath(project, join(source, "worker.ts"), "file", ownerB),
  ).toThrow(ClaimConflictError);
  expect(() => store.claimPath(project, project, "directory", ownerB)).toThrow(
    ClaimConflictError,
  );

  const sibling = store.claimPath(
    project,
    join(project, "README.md"),
    "file",
    ownerB,
  );
  expect(pathClaimTargets(sibling)[0].path).toBe(
    join(realpathSync(project), "README.md"),
  );
});

test("a path batch is stored and released as one claim", () => {
  const { project, store } = fixture();
  const requested = ["Schedule.swift", "MarkdownParsers.swift", "main.swift"];
  const claim = store.claimPaths(
    project,
    requested.map((name) => ({
      path: join(project, name),
      pathType: "file" as const,
    })),
    ownerA,
  );

  expect(store.list(project)).toEqual([claim]);
  expect(pathClaimTargets(claim).map((target) => target.path)).toEqual(
    requested.map((name) => join(realpathSync(project), name)),
  );
  // Already-running pre-group readers see the compatibility projection as a
  // project-wide directory claim. It is deliberately broad but never unsafe.
  expect(claim.path).toBe(realpathSync(project));
  expect(claim.pathType).toBe("directory");
  expect(store.release(project, claim.id, ownerA.id)).toEqual(claim);
  expect(store.list(project)).toEqual([]);
});

test("a replacement process cannot release the original process claim", () => {
  const { project, store } = fixture();
  const originalOwner: ClaimOwner = {
    id: "session-a",
    label: "Original",
    sessionId: "session-a",
    pid: 101,
    instanceId: "original-instance",
  };
  const replacementOwner: ClaimOwner = {
    ...originalOwner,
    pid: 202,
    instanceId: "replacement-instance",
  };
  const claim = store.claimPath(
    project,
    join(project, "owned.ts"),
    "file",
    originalOwner,
  );

  expect(() => store.release(project, claim.id, replacementOwner)).toThrow(
    "only its owner can release it",
  );
  expect(store.list(project)).toEqual([claim]);
});

test("a conflicting path batch creates no partial claims", () => {
  const { project, store } = fixture();
  const occupied = store.claimPath(
    project,
    join(project, "occupied.swift"),
    "file",
    ownerA,
  );

  expect(() =>
    store.claimPaths(
      project,
      [
        { path: join(project, "free.swift"), pathType: "file" },
        { path: join(project, "occupied.swift"), pathType: "file" },
      ],
      ownerB,
    ),
  ).toThrow(ClaimConflictError);
  expect(store.list(project)).toEqual([occupied]);
});

test("every member of a grouped claim participates in conflict detection", () => {
  const { project, store } = fixture();
  const grouped = store.claimPaths(
    project,
    [
      { path: join(project, "one.swift"), pathType: "file" },
      { path: join(project, "two.swift"), pathType: "file" },
    ],
    ownerA,
  );

  expect(() =>
    store.claimPath(project, join(project, "two.swift"), "file", ownerB),
  ).toThrow(ClaimConflictError);
  expect(store.list(project)).toEqual([grouped]);
});

test("legacy singular path records still block grouped claims", () => {
  const { project, claimRoot, store } = fixture();
  const canonical = realpathSync(project);
  const directory = join(claimRoot, projectSlug(canonical));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "legacy.json"),
    JSON.stringify({
      id: "legacy",
      type: "path",
      project: canonical,
      path: join(canonical, "legacy.swift"),
      pathType: "file",
      owner: ownerA,
      createdAt: "2026-08-10T00:00:00.000Z",
    }),
  );

  expect(() =>
    store.claimPaths(
      project,
      [
        { path: join(project, "free.swift"), pathType: "file" },
        { path: join(project, "legacy.swift"), pathType: "file" },
      ],
      ownerB,
    ),
  ).toThrow(ClaimConflictError);
  expect(store.list(project).map((claim) => claim.id)).toEqual(["legacy"]);
});

test("only the owning session can release a claim when owner checking is requested", () => {
  const { project, store } = fixture();
  const claim = store.claimPath(
    project,
    join(project, "notes.md"),
    "file",
    ownerA,
  );

  expect(() => store.release(project, claim.id, ownerB.id)).toThrow(
    "only its owner can release it",
  );
  expect(store.release(project, claim.id, ownerA.id)).toEqual(claim);
  expect(store.list(project)).toEqual([]);
});

test("releaseOwner clears all claims held by one session", () => {
  const { project, notebook, store } = fixture();
  store.claimExperiment(project, notebook, ownerA);
  store.claimPath(project, join(project, "one.md"), "file", ownerA);
  store.claimPath(project, join(project, "two.md"), "file", ownerB);

  expect(store.releaseOwner(project, ownerA.id)).toBe(2);
  expect(store.list(project).map((claim) => claim.owner.id)).toEqual([
    ownerB.id,
  ]);
});

test("a conflicting path claim from a dead session is displaced atomically", () => {
  const { project, store } = fixture();
  const stale = store.claimPaths(
    project,
    [
      { path: join(project, "occupied.swift"), pathType: "file" },
      { path: join(project, "other.swift"), pathType: "file" },
    ],
    ownerA,
  );

  const replacement = store.claimPath(
    project,
    join(project, "occupied.swift"),
    "file",
    ownerB,
    { ownerIsLive: (owner) => owner.id !== stale.owner.id },
  );

  expect(store.list(project)).toEqual([replacement]);
});

test("a live conflict leaves earlier stale conflicts untouched", () => {
  const { project, store } = fixture();
  const stale = store.claimPath(
    project,
    join(project, "stale.swift"),
    "file",
    ownerA,
  );
  const live = store.claimPath(
    project,
    join(project, "live.swift"),
    "file",
    ownerB,
  );

  expect(() =>
    store.claimPaths(
      project,
      [
        { path: join(project, "stale.swift"), pathType: "file" },
        { path: join(project, "live.swift"), pathType: "file" },
      ],
      { id: "agent-c", label: "agent C" },
      { ownerIsLive: (owner) => owner.id === ownerB.id },
    ),
  ).toThrow(ClaimConflictError);
  expect(store.list(project)).toEqual([stale, live]);
});

test("shutdown cleanup only releases claims from the same owner process", () => {
  const { project, store } = fixture();
  const oldOwner = { ...ownerA, pid: 101 };
  const replacementOwner = { ...ownerA, pid: 202 };
  store.claimPath(project, join(project, "old.md"), "file", oldOwner);
  const replacement = store.claimPath(
    project,
    join(project, "replacement.md"),
    "file",
    replacementOwner,
  );

  expect(store.releaseOwner(project, ownerA.id, oldOwner.pid)).toBe(1);
  expect(store.list(project)).toEqual([replacement]);
});

test("experiment allocation ignores directories and non-markdown prefixes", () => {
  const { project, notebook, store } = fixture();
  mkdirSync(join(notebook, "experiments", "EXP-900-scratch"));
  writeFileSync(join(notebook, "experiments", "EXP-800-notes.txt"), "");

  expect(store.claimExperiment(project, notebook, ownerA).experimentId).toBe(
    "EXP-001",
  );
});

test("recovery only removes a claim whose owner is definitively offline", () => {
  const { project, store } = fixture();
  const claim = store.claimPath(
    project,
    join(project, "notes.md"),
    "file",
    ownerA,
  );
  expect(() => store.recover(project, claim.id, () => true)).toThrow(
    "live or cannot be verified offline",
  );
  expect(store.recover(project, claim.id, () => false)).toEqual(claim);
  expect(store.listAll()).toEqual([]);
});

test("an abandoned transaction lock does not permanently block claims", () => {
  const { project, notebook } = fixture();
  const root = dirname(project);
  const claimRoot = join(root, "claims-with-stale-lock");
  const store = new ClaimStore(claimRoot);
  const lock = join(claimRoot, `${projectSlug(project)}.lock`);
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);

  expect(store.claimExperiment(project, notebook, ownerA).experimentId).toBe(
    "EXP-001",
  );
});
