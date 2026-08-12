/** Normalized inspection and safe recovery across claims and work leases. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Claim,
  type ClaimOwner,
  type ClaimStore,
  claims,
  pathClaimTargets,
} from "./claims.ts";
import { displayName } from "./paths.ts";
import { type Registration, listLive } from "./registry.ts";
import {
  type WorkLease,
  type WorkOwner,
  type WorkStore,
  work,
} from "./work.ts";

export type CoordinationKind = "work" | "path-claim" | "experiment-claim";
export type OwnerStatus = "live" | "offline" | "manual";
export type CoordinationCondition =
  | "healthy"
  | "owner-offline"
  | "source-missing"
  | "target-absent"
  | "awaiting-materialization"
  | "materialized";

export interface CoordinationEntry {
  id: string;
  kind: CoordinationKind;
  project: string;
  projectLabel: string;
  resourceType: string;
  resourceKey: string;
  resourceLabel: string;
  sourcePaths: string[];
  owner: ClaimOwner | WorkOwner;
  ownerStatus: OwnerStatus;
  condition: CoordinationCondition;
  recoverable: boolean;
  state?: string;
  activity?: string;
  createdAt: string;
  updatedAt: string;
}

export function ownerStatus(
  owner: ClaimOwner | WorkOwner,
  registrations: Registration[],
): OwnerStatus {
  if (!owner.sessionId || owner.pid === undefined) return "manual";
  return registrations.some(
    (registration) =>
      registration.sessionId === owner.sessionId &&
      registration.pid === owner.pid,
  )
    ? "live"
    : "offline";
}

function experimentFiles(
  claim: Extract<Claim, { type: "experiment" }>,
): string[] {
  const experiments = join(claim.notebook, "experiments");
  if (!existsSync(experiments)) return [];
  return readdirSync(experiments)
    .filter(
      (name) =>
        name === `${claim.experimentId}.md` ||
        name.startsWith(`${claim.experimentId}-`),
    )
    .map((name) => join(experiments, name));
}

function claimEntry(
  claim: Claim,
  registrations: Registration[],
): CoordinationEntry {
  const status = ownerStatus(claim.owner, registrations);
  if (claim.type === "experiment") {
    const files = experimentFiles(claim);
    return {
      id: claim.id,
      kind: "experiment-claim",
      project: claim.project,
      projectLabel: displayName(claim.project),
      resourceType: "experiment-number",
      resourceKey: claim.experimentId,
      resourceLabel: claim.experimentId,
      sourcePaths: files.length ? files : [join(claim.notebook, "experiments")],
      owner: claim.owner,
      ownerStatus: status,
      condition:
        status === "offline"
          ? "owner-offline"
          : files.length
            ? "materialized"
            : "awaiting-materialization",
      recoverable: status === "offline",
      createdAt: claim.createdAt,
      updatedAt: claim.createdAt,
    };
  }

  const paths = pathClaimTargets(claim).map((target) => target.path);
  return {
    id: claim.id,
    kind: "path-claim",
    project: claim.project,
    projectLabel: displayName(claim.project),
    resourceType: "edit-set",
    resourceKey: paths.join(","),
    resourceLabel:
      paths.length === 1 ? paths[0] : `${paths.length} claimed paths`,
    sourcePaths: paths,
    owner: claim.owner,
    ownerStatus: status,
    condition:
      status === "offline"
        ? "owner-offline"
        : paths.some((path) => !existsSync(path))
          ? "target-absent"
          : "healthy",
    recoverable: status === "offline",
    createdAt: claim.createdAt,
    updatedAt: claim.createdAt,
  };
}

function workEntry(
  lease: WorkLease,
  registrations: Registration[],
): CoordinationEntry {
  const status = ownerStatus(lease.owner, registrations);
  const sources = lease.resource.sourcePath ? [lease.resource.sourcePath] : [];
  return {
    id: lease.id,
    kind: "work",
    project: lease.project,
    projectLabel: displayName(lease.project),
    resourceType: lease.resource.type,
    resourceKey: lease.resource.key,
    resourceLabel: lease.resource.label ?? lease.resource.key,
    sourcePaths: sources,
    owner: lease.owner,
    ownerStatus: status,
    condition:
      status === "offline"
        ? "owner-offline"
        : sources.some((path) => !existsSync(path))
          ? "source-missing"
          : "healthy",
    recoverable: status === "offline",
    state: lease.state,
    activity: lease.activity,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

export function listCoordination(
  options: {
    project?: string;
    allProjects?: boolean;
    registrations?: Registration[];
    claimStore?: ClaimStore;
    workStore?: WorkStore;
  } = {},
): CoordinationEntry[] {
  const registrations = options.registrations ?? listLive();
  const claimStore = options.claimStore ?? claims;
  const workStore = options.workStore ?? work;
  const claimRecords = options.allProjects
    ? claimStore.listAll()
    : options.project
      ? claimStore.list(options.project)
      : [];
  const workRecords = options.allProjects
    ? workStore.listAll()
    : options.project
      ? workStore.list(options.project)
      : [];
  return [
    ...workRecords.map((lease) => workEntry(lease, registrations)),
    ...claimRecords.map((claim) => claimEntry(claim, registrations)),
  ].sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function describeCoordination(entry: CoordinationEntry): string {
  const state = entry.state ? ` [${entry.state}]` : "";
  const activity = entry.activity ? ` — ${entry.activity}` : "";
  return `${entry.id} ${entry.projectLabel}/${entry.resourceType}:${entry.resourceLabel} — ${entry.owner.label}${state}${activity} [${entry.condition}] [updated ${entry.updatedAt}]`;
}

export function recoverCoordination(
  coordinationId: string,
  registrations = listLive(),
): CoordinationEntry {
  const matches = listCoordination({ allProjects: true, registrations }).filter(
    (entry) => entry.id === coordinationId,
  );
  if (matches.length === 0) {
    throw new Error(`coordination record not found: ${coordinationId}`);
  }
  if (matches.length > 1) {
    throw new Error(`coordination id is ambiguous: ${coordinationId}`);
  }
  const entry = matches[0];
  if (!entry.recoverable) {
    throw new Error(
      `${coordinationId} belongs to ${entry.owner.label}; its owner is live or cannot be verified offline`,
    );
  }
  const isLive = (owner: ClaimOwner | WorkOwner): boolean =>
    ownerStatus(owner, registrations) !== "offline";
  if (entry.kind === "work") {
    work.recover(entry.project, entry.id, isLive);
  } else {
    claims.recover(entry.project, entry.id, isLive);
  }
  return entry;
}
