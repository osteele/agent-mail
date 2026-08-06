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
import { ClaimConflictError, type ClaimOwner, ClaimStore } from "./claims.ts";
import { projectSlug } from "./paths.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): { project: string; notebook: string; store: ClaimStore } {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-claims-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  return { project, notebook, store: new ClaimStore(join(root, "claims")) };
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
  expect(sibling.path).toBe(join(realpathSync(project), "README.md"));
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
