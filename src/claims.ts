/** Filesystem-backed coordination claims for agents sharing a project. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type LockOwner, withFileLock } from "./lock.ts";
import { CLAIMS_DIR, canonicalProject, projectSlug } from "./paths.ts";

export interface ClaimOwner {
  id: string;
  label: string;
  sessionId?: string;
  pid?: number;
  procStart?: string;
  instanceId?: string;
}

interface ClaimBase {
  id: string;
  project: string;
  owner: ClaimOwner;
  createdAt: string;
}

export interface PathClaimTarget {
  path: string;
  pathType: "file" | "directory";
}

/** Current path-claim shape. Every acquisition is a group, including the
 * singular compatibility API, so one claim id releases the complete edit set.
 * `path` and `pathType` are a conservative projection for already-running
 * pre-group readers: a multi-path group looks like a project-wide directory
 * claim to them, so they over-block rather than silently violate the group. */
export interface PathClaim extends ClaimBase {
  type: "path";
  paths: PathClaimTarget[];
  path: string;
  pathType: "file" | "directory";
}

/** Records written before grouped claims were introduced remain live until
 * their owner releases or disconnects. Keep reading and enforcing them. */
export interface LegacyPathClaim extends ClaimBase {
  type: "path";
  path: string;
  pathType: "file" | "directory";
}

export interface ExperimentClaim extends ClaimBase {
  type: "experiment";
  notebook: string;
  experimentId: string;
  number: number;
}

export type AnyPathClaim = PathClaim | LegacyPathClaim;
export type Claim = AnyPathClaim | ExperimentClaim;

export function pathClaimTargets(claim: AnyPathClaim): PathClaimTarget[] {
  return "paths" in claim
    ? claim.paths
    : [{ path: claim.path, pathType: claim.pathType }];
}

export class ClaimConflictError extends Error {
  constructor(
    public readonly claim: Claim,
    public readonly conflictingPath?: string,
  ) {
    const resource =
      claim.type === "path"
        ? (conflictingPath ??
          pathClaimTargets(claim)
            .map((target) => target.path)
            .join(", "))
        : `${claim.experimentId} in ${claim.notebook}`;
    super(`${resource} is claimed by ${claim.owner.label} (${claim.id})`);
    this.name = "ClaimConflictError";
  }
}

function sameOwnerProcess(a: ClaimOwner, b: ClaimOwner): boolean {
  if (a.id !== b.id) return false;
  if (a.instanceId || b.instanceId) {
    return a.instanceId !== undefined && a.instanceId === b.instanceId;
  }
  if (a.procStart || b.procStart) {
    return (
      a.pid !== undefined &&
      a.pid === b.pid &&
      a.procStart !== undefined &&
      a.procStart === b.procStart
    );
  }
  return (
    a.pid === undefined && b.pid === undefined && !a.sessionId && !b.sessionId
  );
}

function ownerMatches(
  owner: ClaimOwner,
  credential: string | ClaimOwner,
): boolean {
  return typeof credential === "string"
    ? owner.id === credential
    : sameOwnerProcess(owner, credential);
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(
      cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)),
    );
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function isWithin(project: string, path: string): boolean {
  const rel = relative(project, path);
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

export class ClaimStore {
  constructor(private readonly root = CLAIMS_DIR) {}

  private projectDir(project: string): string {
    return join(this.root, projectSlug(project));
  }

  private lockPath(project: string): string {
    return join(this.root, `${projectSlug(project)}.lock`);
  }

  private withLock<T>(project: string, fn: () => T, owner?: LockOwner): T {
    return withFileLock(this.lockPath(project), fn, { owner });
  }

  list(project: string): Claim[] {
    const canonical = canonicalProject(project);
    return this.readDirectory(this.projectDir(canonical));
  }

  private readDirectory(dir: string): Claim[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Claim)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  listAll(): Claim[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock"))
      .flatMap((entry) => this.readDirectory(join(this.root, entry.name)))
      .sort(
        (a, b) =>
          a.project.localeCompare(b.project) ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }

  private write(claim: Claim): void {
    const dir = this.projectDir(claim.project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${claim.id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporary, path);
  }

  claimPath(
    project: string,
    target: string,
    pathType: PathClaimTarget["pathType"],
    owner: ClaimOwner,
    options: {
      ownerIsLive?: (owner: ClaimOwner, claim: Claim) => boolean;
    } = {},
  ): PathClaim {
    return this.claimPaths(
      project,
      [{ path: target, pathType }],
      owner,
      options,
    );
  }

  /** Atomically claim an edit set. Validation and conflict detection complete
   * before the one grouped record is published, so failure leaves no partial
   * claims behind. */
  claimPaths(
    project: string,
    targets: PathClaimTarget[],
    owner: ClaimOwner,
    options: {
      ownerIsLive?: (owner: ClaimOwner, claim: Claim) => boolean;
    } = {},
  ): PathClaim {
    if (targets.length === 0) {
      throw new Error("at least one claim path is required");
    }
    const canonical = canonicalProject(project);
    const canonicalTargets: PathClaimTarget[] = [];
    const seen = new Map<string, PathClaimTarget["pathType"]>();
    for (const target of targets) {
      const path = canonicalPath(target.path);
      if (!isWithin(canonical, path)) {
        throw new Error(
          `claim target must be inside project ${canonical}: ${path}`,
        );
      }
      if (existsSync(path)) {
        const actualType = statSync(path).isDirectory() ? "directory" : "file";
        if (actualType !== target.pathType) {
          throw new Error(
            `${path} is a ${actualType}, not a ${target.pathType}`,
          );
        }
      }
      const previousType = seen.get(path);
      if (previousType && previousType !== target.pathType) {
        throw new Error(
          `${path} cannot be claimed as both a ${previousType} and a ${target.pathType}`,
        );
      }
      if (previousType) continue;
      seen.set(path, target.pathType);
      canonicalTargets.push({ path, pathType: target.pathType });
    }
    return this.withLock(
      canonical,
      () => {
        const staleClaims: Claim[] = [];
        for (const claim of this.list(canonical)) {
          if (claim.type !== "path") continue;
          let conflictingPath: string | undefined;
          for (const existing of pathClaimTargets(claim)) {
            const requested = canonicalTargets.find((target) =>
              pathsConflict(existing, target.path, target.pathType),
            );
            if (requested) {
              conflictingPath = existing.path;
              break;
            }
          }
          if (!conflictingPath) continue;
          if (!options.ownerIsLive || options.ownerIsLive(claim.owner, claim)) {
            throw new ClaimConflictError(claim, conflictingPath);
          }
          staleClaims.push(claim);
        }
        const claim: PathClaim = {
          id: randomUUID(),
          type: "path",
          project: canonical,
          paths: canonicalTargets,
          path:
            canonicalTargets.length === 1
              ? canonicalTargets[0].path
              : canonical,
          pathType:
            canonicalTargets.length === 1
              ? canonicalTargets[0].pathType
              : "directory",
          owner,
          createdAt: new Date().toISOString(),
        };
        this.write(claim);
        // Publishing first makes interruption conservative: a crash can leave
        // duplicate blockers, but never an unowned gap in the edit set.
        for (const stale of staleClaims) {
          unlinkSync(join(this.projectDir(canonical), `${stale.id}.json`));
        }
        return claim;
      },
      owner,
    );
  }

  claimExperiment(
    project: string,
    notebook: string,
    owner: ClaimOwner,
  ): ExperimentClaim {
    const canonical = canonicalProject(project);
    const notebookPath = canonicalPath(notebook);
    if (!isWithin(canonical, notebookPath)) {
      throw new Error(
        `notebook must be inside project ${canonical}: ${notebookPath}`,
      );
    }
    const experiments = join(notebookPath, "experiments");
    if (!existsSync(experiments) || !statSync(experiments).isDirectory()) {
      throw new Error(`experiments directory does not exist: ${experiments}`);
    }
    return this.withLock(
      canonical,
      () => {
        const fileNumbers = readdirSync(experiments, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map(
            (entry) => /^EXP-(\d+)(?:\.md|-[^/]+\.md)$/.exec(entry.name)?.[1],
          )
          .filter((value): value is string => value !== undefined)
          .map(Number);
        const claimedNumbers = this.list(canonical)
          .filter(
            (claim): claim is ExperimentClaim =>
              claim.type === "experiment" && claim.notebook === notebookPath,
          )
          .map((claim) => claim.number);
        const number = Math.max(0, ...fileNumbers, ...claimedNumbers) + 1;
        const experimentId = `EXP-${String(number).padStart(3, "0")}`;
        const claim: ExperimentClaim = {
          id: randomUUID(),
          type: "experiment",
          project: canonical,
          notebook: notebookPath,
          experimentId,
          number,
          owner,
          createdAt: new Date().toISOString(),
        };
        this.write(claim);
        return claim;
      },
      owner,
    );
  }

  release(
    project: string,
    claimId: string,
    owner?: string | ClaimOwner,
  ): Claim {
    const canonical = canonicalProject(project);
    return this.withLock(
      canonical,
      () => {
        const claim = this.list(canonical).find((item) => item.id === claimId);
        if (!claim) throw new Error(`claim not found: ${claimId}`);
        if (owner && !ownerMatches(claim.owner, owner)) {
          throw new Error(
            `claim ${claimId} belongs to ${claim.owner.label}; only its owner can release it`,
          );
        }
        unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
        return claim;
      },
      typeof owner === "object" ? owner : undefined,
    );
  }

  recover(
    project: string,
    claimId: string,
    ownerIsLive: (owner: ClaimOwner, claim: Claim) => boolean,
  ): Claim {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const claim = this.list(canonical).find((item) => item.id === claimId);
      if (!claim) throw new Error(`claim not found: ${claimId}`);
      if (ownerIsLive(claim.owner, claim)) {
        throw new Error(
          `claim ${claimId} belongs to ${claim.owner.label}; its owner is live or cannot be verified offline`,
        );
      }
      unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
      return claim;
    });
  }

  releaseOwner(project: string, ownerId: string, ownerPid?: number): number {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const claims = this.list(canonical).filter(
        (claim) =>
          claim.owner.id === ownerId &&
          (ownerPid === undefined || claim.owner.pid === ownerPid),
      );
      for (const claim of claims) {
        unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
      }
      return claims.length;
    });
  }
}

export const claims = new ClaimStore();
