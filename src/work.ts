/** Filesystem-backed exclusive leases for logical units of agent work. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type LockOwner, withFileLock } from "./lock.ts";
import { WORK_DIR, canonicalProject, projectSlug } from "./paths.ts";

export interface WorkOwner {
  id: string;
  label: string;
  sessionId?: string;
  pid?: number;
  procStart?: string;
  instanceId?: string;
}

export interface WorkResource {
  type: string;
  key: string;
  label?: string;
  sourcePath?: string;
}

export type WorkState = "working" | "waiting";

export interface WorkLease {
  version: 1;
  id: string;
  project: string;
  resource: WorkResource;
  owner: WorkOwner;
  state: WorkState;
  activity?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export class WorkConflictError extends Error {
  constructor(public readonly lease: WorkLease) {
    super(
      `${lease.resource.type}:${lease.resource.key} is being worked by ${lease.owner.label} (${lease.id})`,
    );
    this.name = "WorkConflictError";
  }
}

export class WorkTransferSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkTransferSupersededError";
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

function validateToken(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > 240) throw new Error(`${name} is too long`);
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

function validateText(
  value: string | undefined,
  name: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) throw new Error(`${name} is too long`);
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

export function sameWorkOwner(a: WorkOwner, b: WorkOwner): boolean {
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
  owner: WorkOwner,
  credential: string | WorkOwner,
): boolean {
  return typeof credential === "string"
    ? owner.id === credential
    : sameWorkOwner(owner, credential);
}

export class WorkStore {
  constructor(private readonly root = WORK_DIR) {}

  private projectDir(project: string): string {
    return join(this.root, projectSlug(project));
  }

  private lockPath(project: string): string {
    return join(this.root, `${projectSlug(project)}.lock`);
  }

  private withLock<T>(project: string, fn: () => T, owner?: LockOwner): T {
    return withFileLock(this.lockPath(project), fn, { owner });
  }

  private readDirectory(dir: string): WorkLease[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(dir, name), "utf8")) as WorkLease,
      );
  }

  list(project: string): WorkLease[] {
    const canonical = canonicalProject(project);
    return this.readDirectory(this.projectDir(canonical)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  listAll(): WorkLease[] {
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

  private write(lease: WorkLease, replace = false): WorkLease {
    const dir = this.projectDir(lease.project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${lease.id}.json`);
    const priorRevision = existsSync(path)
      ? ((JSON.parse(readFileSync(path, "utf8")) as WorkLease).revision ?? 0)
      : 0;
    const withRevision: WorkLease = { ...lease, revision: priorRevision + 1 };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(withRevision, null, 2)}\n`, {
      flag: "wx",
    });
    if (!replace && existsSync(path)) {
      unlinkSync(temporary);
      throw new Error(`work lease already exists: ${lease.id}`);
    }
    renameSync(temporary, path);
    return withRevision;
  }

  acquire(
    project: string,
    resource: WorkResource,
    owner: WorkOwner,
    options: {
      state?: WorkState;
      activity?: string;
      ownerIsLive?: (owner: WorkOwner, lease: WorkLease) => boolean;
    } = {},
  ): WorkLease {
    const canonical = canonicalProject(project);
    const label = validateText(resource.label, "resource label");
    const normalizedResource: WorkResource = {
      type: validateToken(resource.type, "resource type"),
      key: validateToken(resource.key, "resource key"),
      ...(label ? { label } : {}),
    };
    if (resource.sourcePath) {
      const sourcePath = canonicalPath(resource.sourcePath);
      if (!isWithin(canonical, sourcePath)) {
        throw new Error(
          `work source must be inside project ${canonical}: ${sourcePath}`,
        );
      }
      normalizedResource.sourcePath = sourcePath;
    }

    return this.withLock(
      canonical,
      () => {
        const activity = validateText(options.activity, "activity");
        const existing = this.list(canonical).filter(
          (lease) =>
            lease.resource.type === normalizedResource.type &&
            lease.resource.key === normalizedResource.key,
        );
        const owned = existing.find((lease) =>
          sameWorkOwner(lease.owner, owner),
        );
        const conflicts = existing.filter(
          (lease) => !sameWorkOwner(lease.owner, owner),
        );
        const now = new Date().toISOString();
        for (const conflict of conflicts) {
          if (
            !options.ownerIsLive ||
            options.ownerIsLive(conflict.owner, conflict)
          ) {
            throw new WorkConflictError(conflict);
          }
        }
        if (owned) {
          const updated: WorkLease = {
            ...owned,
            resource: normalizedResource,
            owner,
            state: options.state ?? owned.state,
            ...(options.activity !== undefined ? { activity } : {}),
            updatedAt: now,
          };
          const written = this.write(updated, true);
          for (const duplicate of existing) {
            if (duplicate.id !== owned.id) {
              unlinkSync(
                join(this.projectDir(canonical), `${duplicate.id}.json`),
              );
            }
          }
          return written;
        }
        const lease: WorkLease = {
          version: 1,
          id: randomUUID(),
          project: canonical,
          resource: normalizedResource,
          owner,
          state: options.state ?? "working",
          ...(activity ? { activity } : {}),
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        const written = this.write(lease);
        if (existing.length > 0) {
          // Publish the replacement before removing the stale owner. An
          // interruption may over-block with two records but cannot create a
          // window where the resource has no owner.
          for (const stale of existing) {
            unlinkSync(join(this.projectDir(canonical), `${stale.id}.json`));
          }
        }
        return written;
      },
      owner,
    );
  }

  update(
    project: string,
    leaseId: string,
    owner: string | WorkOwner,
    changes: { state?: WorkState; activity?: string },
  ): WorkLease {
    const canonical = canonicalProject(project);
    return this.withLock(
      canonical,
      () => {
        const lease = this.list(canonical).find((item) => item.id === leaseId);
        if (!lease) throw new Error(`work lease not found: ${leaseId}`);
        if (!ownerMatches(lease.owner, owner)) {
          throw new Error(
            `work lease ${leaseId} belongs to ${lease.owner.label}; only its owner can update it`,
          );
        }
        const updated: WorkLease = {
          ...lease,
          state: changes.state ?? lease.state,
          ...(changes.activity !== undefined
            ? { activity: validateText(changes.activity, "activity") }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        return this.write(updated, true);
      },
      typeof owner === "object" ? owner : undefined,
    );
  }

  release(
    project: string,
    leaseId: string,
    owner?: string | WorkOwner,
  ): WorkLease {
    const canonical = canonicalProject(project);
    return this.withLock(
      canonical,
      () => {
        const lease = this.list(canonical).find((item) => item.id === leaseId);
        if (!lease) throw new Error(`work lease not found: ${leaseId}`);
        if (owner && !ownerMatches(lease.owner, owner)) {
          throw new Error(
            `work lease ${leaseId} belongs to ${lease.owner.label}; only its owner can release it`,
          );
        }
        unlinkSync(join(this.projectDir(canonical), `${lease.id}.json`));
        return lease;
      },
      typeof owner === "object" ? owner : undefined,
    );
  }

  /** Atomically replace the exact owner/version captured by a transfer request. */
  transfer(
    project: string,
    leaseId: string,
    expectedOwner: WorkOwner,
    expectedRevision: number,
    newOwner: WorkOwner,
  ): WorkLease {
    const canonical = canonicalProject(project);
    return this.withLock(
      canonical,
      () => {
        const lease = this.list(canonical).find((item) => item.id === leaseId);
        if (!lease) {
          throw new WorkTransferSupersededError(
            `work lease not found: ${leaseId}`,
          );
        }
        if (sameWorkOwner(lease.owner, newOwner)) return lease;
        if (
          !sameWorkOwner(lease.owner, expectedOwner) ||
          lease.revision !== expectedRevision
        ) {
          throw new WorkTransferSupersededError(
            `work lease ${leaseId} changed after the transfer request`,
          );
        }
        const transferred: WorkLease = {
          ...lease,
          owner: newOwner,
          state: "working",
          activity: `Transferred from ${expectedOwner.label}`,
          updatedAt: new Date().toISOString(),
        };
        return this.write(transferred, true);
      },
      expectedOwner,
    );
  }

  recover(
    project: string,
    leaseId: string,
    ownerIsLive: (owner: WorkOwner, lease: WorkLease) => boolean,
  ): WorkLease {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const lease = this.list(canonical).find((item) => item.id === leaseId);
      if (!lease) throw new Error(`work lease not found: ${leaseId}`);
      if (ownerIsLive(lease.owner, lease)) {
        throw new Error(
          `work lease ${leaseId} belongs to ${lease.owner.label}; its owner is live or cannot be verified offline`,
        );
      }
      unlinkSync(join(this.projectDir(canonical), `${lease.id}.json`));
      return lease;
    });
  }

  releaseOwner(project: string, ownerId: string, ownerPid?: number): number {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const leases = this.list(canonical).filter(
        (lease) =>
          lease.owner.id === ownerId &&
          (ownerPid === undefined || lease.owner.pid === ownerPid),
      );
      for (const lease of leases) {
        unlinkSync(join(this.projectDir(canonical), `${lease.id}.json`));
      }
      return leases.length;
    });
  }
}

export const work = new WorkStore();
