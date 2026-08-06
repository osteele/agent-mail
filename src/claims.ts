/** Filesystem-backed coordination claims for agents sharing a project. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CLAIMS_DIR, canonicalProject, projectSlug } from "./paths.ts";

export interface ClaimOwner {
  id: string;
  label: string;
  sessionId?: string;
  pid?: number;
}

interface ClaimBase {
  id: string;
  project: string;
  owner: ClaimOwner;
  createdAt: string;
}

export interface PathClaim extends ClaimBase {
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

export type Claim = PathClaim | ExperimentClaim;

export class ClaimConflictError extends Error {
  constructor(public readonly claim: Claim) {
    const resource =
      claim.type === "path"
        ? claim.path
        : `${claim.experimentId} in ${claim.notebook}`;
    super(`${resource} is claimed by ${claim.owner.label} (${claim.id})`);
    this.name = "ClaimConflictError";
  }
}

function canonicalPath(path: string): string {
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
  a: PathClaim,
  path: string,
  pathType: PathClaim["pathType"],
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

  private withLock<T>(project: string, fn: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const lock = this.lockPath(project);
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        // A process can die between mkdir and rmdir. Claim mutations are tiny,
        // synchronous transactions, so an old lock directory is an abandoned
        // mutex rather than evidence of work still in progress.
        let lockMtime: number;
        try {
          lockMtime = statSync(lock).mtimeMs;
        } catch (statError) {
          if (
            statError instanceof Error &&
            "code" in statError &&
            statError.code === "ENOENT"
          ) {
            continue;
          }
          throw statError;
        }
        if (Date.now() - lockMtime > 30_000) {
          try {
            rmdirSync(lock);
          } catch (removeError) {
            if (
              !(removeError instanceof Error) ||
              !("code" in removeError) ||
              removeError.code !== "ENOENT"
            ) {
              throw removeError;
            }
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for claim lock for ${project}`);
        }
        Bun.sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      rmdirSync(lock);
    }
  }

  list(project: string): Claim[] {
    const canonical = canonicalProject(project);
    const dir = this.projectDir(canonical);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Claim)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    pathType: PathClaim["pathType"],
    owner: ClaimOwner,
  ): PathClaim {
    const canonical = canonicalProject(project);
    const path = canonicalPath(target);
    if (!isWithin(canonical, path)) {
      throw new Error(
        `claim target must be inside project ${canonical}: ${path}`,
      );
    }
    if (existsSync(path)) {
      const actualType = statSync(path).isDirectory() ? "directory" : "file";
      if (actualType !== pathType) {
        throw new Error(`${path} is a ${actualType}, not a ${pathType}`);
      }
    }
    return this.withLock(canonical, () => {
      const conflict = this.list(canonical).find(
        (claim): claim is PathClaim =>
          claim.type === "path" && pathsConflict(claim, path, pathType),
      );
      if (conflict) throw new ClaimConflictError(conflict);
      const claim: PathClaim = {
        id: randomUUID(),
        type: "path",
        project: canonical,
        path,
        pathType,
        owner,
        createdAt: new Date().toISOString(),
      };
      this.write(claim);
      return claim;
    });
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
    return this.withLock(canonical, () => {
      const fileNumbers = readdirSync(experiments)
        .map((name) => /^EXP-(\d+)(?:-|\.md$)/.exec(name)?.[1])
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
    });
  }

  release(project: string, claimId: string, ownerId?: string): Claim {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const claim = this.list(canonical).find((item) => item.id === claimId);
      if (!claim) throw new Error(`claim not found: ${claimId}`);
      if (ownerId && claim.owner.id !== ownerId) {
        throw new Error(
          `claim ${claimId} belongs to ${claim.owner.label}; only its owner can release it`,
        );
      }
      unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
      return claim;
    });
  }

  releaseOwner(project: string, ownerId: string): number {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const claims = this.list(canonical).filter(
        (claim) => claim.owner.id === ownerId,
      );
      for (const claim of claims) {
        unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
      }
      return claims.length;
    });
  }
}

export const claims = new ClaimStore();
