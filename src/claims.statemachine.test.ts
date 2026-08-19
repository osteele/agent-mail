import { afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import fc from "fast-check";
import {
  ClaimConflictError,
  type ClaimOwner,
  ClaimStore,
  type PathClaimTarget,
  canonicalPath,
  pathClaimTargets,
} from "./claims.ts";
import { slowTest } from "./slowTests.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeProject(): {
  project: string;
  notebook: string;
  store: ClaimStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-claims-sm-"));
  temporaryDirectories.push(root);
  const project = resolve(join(root, "project"));
  const notebook = resolve(join(project, "lab-notebook"));
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  const claimRoot = resolve(join(root, "claims"));
  return { project, notebook, store: new ClaimStore(claimRoot) };
}

const OWNER_IDS = ["alice", "bob", "carol"] as const;
type OwnerId = (typeof OWNER_IDS)[number];

function makeOwner(id: OwnerId): ClaimOwner {
  return { id, label: `agent ${id}` };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathsConflict(
  a: PathClaimTarget,
  path: string,
  pathType: PathClaimTarget["pathType"],
): boolean {
  if (a.path === path) return true;
  if (a.pathType === "directory" && isWithin(a.path, path)) return true;
  return pathType === "directory" && isWithin(path, a.path);
}

/** True if claiming `relPath` as `pathType` would contradict an existing
 * filesystem-shape assumption (e.g., claiming `c` as a file when `c/src` is
 * already known to exist as a file, which requires `c` to be a directory). */
function hasTypeConflict(
  m: Readonly<ClaimModel>,
  relPath: string,
  pathType: PathClaimTarget["pathType"],
): boolean {
  for (const [existingPath, existingType] of m.pathTypes) {
    if (existingPath === relPath) return existingType !== pathType;
    const existingIsPrefix =
      existingPath.length < relPath.length &&
      relPath.startsWith(`${existingPath}/`);
    const newIsPrefix =
      relPath.length < existingPath.length &&
      existingPath.startsWith(`${relPath}/`);
    if (existingIsPrefix && existingType === "file") return true;
    if (newIsPrefix && pathType === "file") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model-based claims state-machine test
// ---------------------------------------------------------------------------

interface ClaimModel {
  project: string;
  notebook: string;
  owners: Map<OwnerId, ClaimOwner>;
  pathClaims: Map<
    string,
    {
      ownerId: OwnerId;
      targets: PathClaimTarget[];
    }
  >;
  experimentClaims: Map<
    string,
    {
      ownerId: OwnerId;
      notebook: string;
      number: number;
      experimentId: string;
    }
  >;
  pathTypes: Map<string, PathClaimTarget["pathType"]>;
}

interface ClaimReal {
  project: string;
  notebook: string;
  store: ClaimStore;
}

interface ClaimPathPayload {
  ownerId: OwnerId;
  relPath: string;
  pathType: PathClaimTarget["pathType"];
}

class ClaimPathCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(readonly payload: ClaimPathPayload) {}

  check(m: Readonly<ClaimModel>): boolean {
    return !hasTypeConflict(m, this.payload.relPath, this.payload.pathType);
  }

  private target(m: ClaimModel): PathClaimTarget {
    return {
      path: canonicalPath(resolve(m.project, this.payload.relPath)),
      pathType: this.payload.pathType,
    };
  }

  private conflictId(m: ClaimModel): string | undefined {
    const target = this.target(m);
    for (const [id, claim] of m.pathClaims) {
      for (const existing of claim.targets) {
        if (pathsConflict(existing, target.path, target.pathType)) {
          return id;
        }
      }
    }
    return undefined;
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const owner =
      m.owners.get(this.payload.ownerId) ?? makeOwner(this.payload.ownerId);
    m.owners.set(this.payload.ownerId, owner);
    const target = this.target(m);
    ensurePath(target);
    recordParentTypes(m, this.payload.relPath, this.payload.pathType);

    const conflictId = this.conflictId(m);
    if (conflictId) {
      expect(() =>
        r.store.claimPath(r.project, target.path, target.pathType, owner),
      ).toThrow(ClaimConflictError);
      return;
    }

    const claim = r.store.claimPath(
      r.project,
      target.path,
      target.pathType,
      owner,
    );
    m.pathClaims.set(claim.id, {
      ownerId: this.payload.ownerId,
      targets: [target],
    });
    m.pathTypes.set(this.payload.relPath, target.pathType);
    expect(pathClaimTargets(claim)).toEqual([target]);
  }

  toString(): string {
    return `ClaimPath(${JSON.stringify(this.payload)})`;
  }
}

class ClaimPathsCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(
    readonly payload: {
      ownerId: OwnerId;
      targets: { relPath: string; pathType: PathClaimTarget["pathType"] }[];
    },
  ) {}

  check(m: Readonly<ClaimModel>): boolean {
    if (this.payload.targets.length === 0) return false;
    const targets = this.payload.targets;
    for (let i = 0; i < targets.length; i++) {
      const a = targets[i];
      if (hasTypeConflict(m, a.relPath, a.pathType)) return false;
      for (let j = 0; j < targets.length; j++) {
        if (i === j) continue;
        const b = targets[j];
        const aIsPrefix =
          a.relPath.length < b.relPath.length &&
          b.relPath.startsWith(`${a.relPath}/`);
        if (aIsPrefix && a.pathType === "file") return false;
      }
    }
    return true;
  }

  private targets(m: ClaimModel): PathClaimTarget[] {
    return this.payload.targets.map((t) => ({
      path: canonicalPath(resolve(m.project, t.relPath)),
      pathType: t.pathType,
    }));
  }

  private conflictId(m: ClaimModel): string | undefined {
    const targets = this.targets(m);
    for (const [id, claim] of m.pathClaims) {
      for (const existing of claim.targets) {
        for (const target of targets) {
          if (pathsConflict(existing, target.path, target.pathType)) {
            return id;
          }
        }
      }
    }
    return undefined;
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const owner =
      m.owners.get(this.payload.ownerId) ?? makeOwner(this.payload.ownerId);
    m.owners.set(this.payload.ownerId, owner);
    const allTargets = this.targets(m);
    for (const target of allTargets) ensurePath(target);
    for (const target of this.payload.targets) {
      recordParentTypes(m, target.relPath, target.pathType);
    }

    // The real ClaimStore deduplicates identical paths within a batch.
    const seen = new Map<string, PathClaimTarget["pathType"]>();
    const targets: PathClaimTarget[] = [];
    for (const target of allTargets) {
      const previousType = seen.get(target.path);
      if (previousType) {
        if (previousType !== target.pathType) {
          expect(() =>
            r.store.claimPaths(r.project, allTargets, owner),
          ).toThrow();
          return;
        }
        continue;
      }
      seen.set(target.path, target.pathType);
      targets.push(target);
    }

    const conflictId = this.conflictId(m);
    const before = r.store.list(r.project).length;
    if (conflictId) {
      expect(() => r.store.claimPaths(r.project, targets, owner)).toThrow(
        ClaimConflictError,
      );
      expect(r.store.list(r.project).length).toBe(before);
      return;
    }

    const claim = r.store.claimPaths(r.project, targets, owner);
    expect(pathClaimTargets(claim)).toEqual(targets);
    m.pathClaims.set(claim.id, {
      ownerId: this.payload.ownerId,
      targets,
    });
    for (const target of this.payload.targets) {
      m.pathTypes.set(target.relPath, target.pathType);
    }
  }

  toString(): string {
    return `ClaimPaths(${JSON.stringify(this.payload)})`;
  }
}

class ClaimExperimentCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(readonly ownerId: OwnerId) {}

  check(): boolean {
    return true;
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const owner = m.owners.get(this.ownerId) ?? makeOwner(this.ownerId);
    m.owners.set(this.ownerId, owner);
    const claimedNumbers = [...m.experimentClaims.values()]
      .filter((c) => c.notebook === r.notebook)
      .map((c) => c.number);
    const expectedNumber = Math.max(0, ...claimedNumbers) + 1;
    const claim = r.store.claimExperiment(r.project, r.notebook, owner);
    expect(claim.number).toBe(expectedNumber);
    expect(claim.experimentId).toBe(
      `EXP-${String(expectedNumber).padStart(3, "0")}`,
    );
    m.experimentClaims.set(claim.id, {
      ownerId: this.ownerId,
      notebook: r.notebook,
      number: claim.number,
      experimentId: claim.experimentId,
    });
  }

  toString(): string {
    return `ClaimExperiment(${this.ownerId})`;
  }
}

class ReleaseClaimCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(readonly payload: { actorId: OwnerId; targetOwnerId: OwnerId }) {}

  check(m: Readonly<ClaimModel>): boolean {
    return [...m.pathClaims.values(), ...m.experimentClaims.values()].some(
      (claim) => claim.ownerId === this.payload.targetOwnerId,
    );
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const entries = [
      ...m.pathClaims.entries(),
      ...m.experimentClaims.entries(),
    ];
    const match = entries.find(
      ([, c]) => c.ownerId === this.payload.targetOwnerId,
    );
    if (!match) return;
    const [claimId, claim] = match;
    if (this.payload.actorId !== claim.ownerId) {
      expect(() =>
        r.store.release(r.project, claimId, this.payload.actorId),
      ).toThrow("only its owner can release it");
      return;
    }

    r.store.release(r.project, claimId, this.payload.actorId);
    m.pathClaims.delete(claimId);
    m.experimentClaims.delete(claimId);
  }

  toString(): string {
    return `ReleaseClaim(${JSON.stringify(this.payload)})`;
  }
}

class RecoverClaimCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(readonly payload: { ownerIsLive: boolean }) {}

  check(m: Readonly<ClaimModel>): boolean {
    return m.pathClaims.size + m.experimentClaims.size > 0;
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const entries = [
      ...m.pathClaims.entries(),
      ...m.experimentClaims.entries(),
    ];
    const [claimId] = entries[0];
    if (this.payload.ownerIsLive) {
      expect(() => r.store.recover(r.project, claimId, () => true)).toThrow(
        "live or cannot be verified offline",
      );
      return;
    }

    r.store.recover(r.project, claimId, () => false);
    m.pathClaims.delete(claimId);
    m.experimentClaims.delete(claimId);
  }

  toString(): string {
    return `RecoverClaim(${JSON.stringify(this.payload)})`;
  }
}

class ReleaseOwnerCommand implements fc.Command<ClaimModel, ClaimReal> {
  constructor(readonly ownerId: OwnerId) {}

  check(): boolean {
    return true;
  }

  run(m: ClaimModel, r: ClaimReal): void {
    const count = r.store.releaseOwner(r.project, this.ownerId);
    let modelCount = 0;
    for (const [id, claim] of m.pathClaims) {
      if (claim.ownerId === this.ownerId) {
        m.pathClaims.delete(id);
        modelCount++;
      }
    }
    for (const [id, claim] of m.experimentClaims) {
      if (claim.ownerId === this.ownerId) {
        m.experimentClaims.delete(id);
        modelCount++;
      }
    }
    expect(count).toBe(modelCount);
  }

  toString(): string {
    return `ReleaseOwner(${this.ownerId})`;
  }
}

function ensurePath(target: PathClaimTarget): void {
  mkdirSync(resolve(target.path, ".."), { recursive: true });
}

/** Record that every parent directory of `relPath` inside the project is a
 * directory, because `mkdirSync(..., { recursive: true })` creates them. */
function recordParentTypes(
  m: ClaimModel,
  relPath: string,
  pathType: PathClaimTarget["pathType"],
): void {
  const parts = relPath.split("/");
  // For a file, all ancestors are directories; for a directory, all but the
  // last segment are directories.
  const depth = pathType === "file" ? parts.length : parts.length - 1;
  for (let i = 1; i <= depth; i++) {
    const ancestor = parts.slice(0, i).join("/");
    m.pathTypes.set(ancestor, "directory");
  }
}

function assertInvariants(m: ClaimModel, r: ClaimReal): void {
  const real = r.store.list(r.project);
  expect(real.length).toBe(m.pathClaims.size + m.experimentClaims.size);

  // No overlapping path claims across different owners/claims.
  const activePaths: { target: PathClaimTarget; claimId: string }[] = [];
  for (const [claimId, claim] of m.pathClaims) {
    for (const target of claim.targets) {
      for (const existing of activePaths) {
        if (existing.claimId === claimId) continue;
        expect(
          pathsConflict(existing.target, target.path, target.pathType),
        ).toBe(false);
      }
      activePaths.push({ target, claimId });
    }
  }

  // Experiment numbers are unique.
  const numbers = new Set<number>();
  for (const claim of m.experimentClaims.values()) {
    expect(numbers.has(claim.number)).toBe(false);
    numbers.add(claim.number);
  }

  // Real store contains exactly the modeled claims.
  const realIds = new Set(real.map((c) => c.id));
  const modelIds = new Set([
    ...m.pathClaims.keys(),
    ...m.experimentClaims.keys(),
  ]);
  expect(realIds).toEqual(modelIds);
}

const ownerArb = fc.constantFrom(...OWNER_IDS);
const pathTypeArb = fc.constantFrom<PathClaimTarget["pathType"]>(
  "file",
  "directory",
);
const relPathArb = fc
  .array(fc.constantFrom("src", "test", "lib", "a", "b", "c"), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join("/"));

const claimPathArb = fc
  .record({
    ownerId: ownerArb,
    relPath: relPathArb,
    pathType: pathTypeArb,
  })
  .map((payload) => new ClaimPathCommand(payload));

const claimPathsArb = fc
  .record({
    ownerId: ownerArb,
    targets: fc.array(
      fc.record({ relPath: relPathArb, pathType: pathTypeArb }),
      { minLength: 1, maxLength: 3 },
    ),
  })
  .map((payload) => new ClaimPathsCommand(payload));

const commandArb = fc.oneof(
  { weight: 4, arbitrary: claimPathArb },
  { weight: 2, arbitrary: claimPathsArb },
  {
    weight: 3,
    arbitrary: ownerArb.map((id) => new ClaimExperimentCommand(id)),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ actorId: ownerArb, targetOwnerId: ownerArb })
      .map((payload) => new ReleaseClaimCommand(payload)),
  },
  {
    weight: 1,
    arbitrary: fc
      .boolean()
      .map((ownerIsLive) => new RecoverClaimCommand({ ownerIsLive })),
  },
  { weight: 1, arbitrary: ownerArb.map((id) => new ReleaseOwnerCommand(id)) },
);

const seed: Parameters<typeof fc.assert>[1] = { seed: 42 };

slowTest(
  "claims state machine preserves path and experiment invariants",
  () => {
    fc.assert(
      fc.property(fc.commands([commandArb], { size: "+1" }), (cmds) => {
        const { project, notebook, store } = makeProject();
        const initialModel: ClaimModel = {
          project,
          notebook,
          owners: new Map(),
          pathClaims: new Map(),
          experimentClaims: new Map(),
          pathTypes: new Map(),
        };
        const initialReal: ClaimReal = { project, notebook, store };
        const setup = () => ({ model: initialModel, real: initialReal });
        fc.modelRun(setup, cmds);
        assertInvariants(initialModel, initialReal);
      }),
      { ...seed, numRuns: 30 },
    );
  },
);
