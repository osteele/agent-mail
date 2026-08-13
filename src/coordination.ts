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
import { coordinationProcessEvidence } from "./processSnapshot.ts";
import {
  type ProcessInfo,
  type ProcessScan,
  type Registration,
  listLive,
} from "./registry.ts";
import {
  type WorkLease,
  type WorkOwner,
  type WorkStore,
  work,
} from "./work.ts";

export type CoordinationKind = "work" | "path-claim" | "experiment-claim";
export type OwnerStatus = "live" | "offline" | "manual" | "unverifiable";
export type CoordinationCondition =
  | "healthy"
  | "owner-offline"
  | "owner-unverifiable"
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
  ownerLastSeen?: string;
  ownerStartedAt?: string;
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
  createdAt?: string,
  processEvidence?: Map<number, ProcessInfo> | ProcessScan,
  registrationsReliable = true,
): OwnerStatus {
  if (owner.sessionId && owner.pid !== undefined) {
    const registration = registrations.find(
      (registration) =>
        registration.sessionId === owner.sessionId &&
        registration.pid === owner.pid,
    );
    if (!registration)
      return registrationsReliable ? "offline" : "unverifiable";
    if (owner.instanceId) {
      return registration.instanceId === owner.instanceId ? "live" : "offline";
    }
    if (owner.procStart) {
      return registration.procStart === owner.procStart ? "live" : "offline";
    }
    if (createdAt) {
      const registeredAt = Date.parse(registration.started);
      const recordCreatedAt = Date.parse(createdAt);
      if (!Number.isFinite(registeredAt) || !Number.isFinite(recordCreatedAt)) {
        return "unverifiable";
      }
      if (registeredAt > recordCreatedAt) return "offline";
    }
    return "live";
  }
  if (owner.pid === undefined) return "manual";

  const scan =
    processEvidence instanceof Map
      ? { processes: processEvidence, reliable: true }
      : (processEvidence ?? coordinationProcessEvidence([owner.pid]));
  if (!scan.reliable) return "unverifiable";
  const info = scan.processes.get(owner.pid);
  if (!info) return "offline";
  if (owner.procStart) {
    return owner.procStart === info.start ? "live" : "offline";
  }

  // Legacy CLI records stored a pid but not its process start. A replacement
  // process with the same pid must have started after the record was created,
  // so the timestamps still prove that the original owner is dead. If either
  // timestamp cannot be parsed, preserve the record as unverifiable.
  const processStartedAt = Date.parse(info.start);
  const recordCreatedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(processStartedAt) || !Number.isFinite(recordCreatedAt)) {
    return "unverifiable";
  }
  return processStartedAt <= recordCreatedAt ? "live" : "offline";
}

function ownerRegistration(
  owner: ClaimOwner | WorkOwner,
  registrations: Registration[],
): Registration | undefined {
  if (!owner.sessionId || owner.pid === undefined) return undefined;
  return registrations.find(
    (registration) =>
      registration.sessionId === owner.sessionId &&
      registration.pid === owner.pid &&
      (!owner.instanceId || registration.instanceId === owner.instanceId) &&
      (!owner.procStart || registration.procStart === owner.procStart),
  );
}

function experimentFiles(
  claim: Extract<Claim, { type: "experiment" }>,
): string[] {
  const experiments = join(claim.notebook, "experiments");
  if (!existsSync(experiments)) return [];
  return readdirSync(experiments, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === `${claim.experimentId}.md` ||
          (entry.name.startsWith(`${claim.experimentId}-`) &&
            entry.name.endsWith(".md"))),
    )
    .map((entry) => join(experiments, entry.name));
}

function claimEntry(
  claim: Claim,
  registrations: Registration[],
  processes: ProcessScan,
  registrationsReliable: boolean,
): CoordinationEntry {
  const status = ownerStatus(
    claim.owner,
    registrations,
    claim.createdAt,
    processes,
    registrationsReliable,
  );
  const registration =
    status === "offline"
      ? undefined
      : ownerRegistration(claim.owner, registrations);
  const ownerActivity = {
    ...(registration?.lastSeen ? { ownerLastSeen: registration.lastSeen } : {}),
    ...(registration?.started ? { ownerStartedAt: registration.started } : {}),
  };
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
      ...ownerActivity,
      condition:
        status === "offline"
          ? "owner-offline"
          : status === "unverifiable"
            ? "owner-unverifiable"
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
    ...ownerActivity,
    condition:
      status === "offline"
        ? "owner-offline"
        : status === "unverifiable"
          ? "owner-unverifiable"
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
  processes: ProcessScan,
  registrationsReliable: boolean,
): CoordinationEntry {
  const status = ownerStatus(
    lease.owner,
    registrations,
    lease.createdAt,
    processes,
    registrationsReliable,
  );
  const registration =
    status === "offline"
      ? undefined
      : ownerRegistration(lease.owner, registrations);
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
    ...(registration?.lastSeen ? { ownerLastSeen: registration.lastSeen } : {}),
    ...(registration?.started ? { ownerStartedAt: registration.started } : {}),
    condition:
      status === "offline"
        ? "owner-offline"
        : status === "unverifiable"
          ? "owner-unverifiable"
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
    registrationsReliable?: boolean;
    processes?: Map<number, ProcessInfo> | ProcessScan;
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
  const ownerPids = [...workRecords, ...claimRecords]
    .map((record) => record.owner)
    .filter((owner) => !owner.sessionId && owner.pid !== undefined)
    .map((owner) => owner.pid as number);
  const processes =
    options.processes instanceof Map
      ? { processes: options.processes, reliable: true }
      : (options.processes ?? coordinationProcessEvidence(ownerPids));
  return [
    ...workRecords.map((lease) =>
      workEntry(
        lease,
        registrations,
        processes,
        options.registrationsReliable ?? true,
      ),
    ),
    ...claimRecords.map((claim) =>
      claimEntry(
        claim,
        registrations,
        processes,
        options.registrationsReliable ?? true,
      ),
    ),
  ].sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function describeCoordination(entry: CoordinationEntry): string {
  const state = entry.state ? ` [${entry.state}]` : "";
  const activity = entry.activity ? ` — ${entry.activity}` : "";
  const identity = [
    entry.owner.id,
    entry.owner.sessionId && entry.owner.sessionId !== entry.owner.id
      ? `session ${entry.owner.sessionId}`
      : undefined,
    entry.owner.pid !== undefined ? `pid ${entry.owner.pid}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const lastSeen = entry.ownerLastSeen
    ? `; last seen ${entry.ownerLastSeen}`
    : "";
  return `${entry.id} ${entry.projectLabel}/${entry.resourceType}:${entry.resourceLabel} — ${entry.owner.label} (${identity})${state}${activity} [${entry.condition}] [owner ${entry.ownerStatus}${lastSeen}] [updated ${entry.updatedAt}]`;
}

/** Actionable conflict guidance without weakening ownership safeguards. */
export function coordinationConflictAdvice(entry: CoordinationEntry): string {
  if (entry.ownerStatus === "offline") {
    return `owner is offline; retry acquisition or run agent-mail coordination recover --id ${entry.id}`;
  }
  if (entry.ownerStatus === "unverifiable") {
    return `owner liveness is unverifiable in this sandbox; inspect from a normal terminal, then run agent-mail coordination recover --id ${entry.id} if it reports owner-offline`;
  }
  if (entry.ownerStatus === "manual") {
    return "owner is deliberately manual; ask the operator to release it";
  }
  return "owner is live; use request_coordination_transfer for an auditable handoff";
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
  const isLive = (
    owner: ClaimOwner | WorkOwner,
    record: Claim | WorkLease,
  ): boolean => ownerStatus(owner, listLive(), record.createdAt) !== "offline";
  if (entry.kind === "work") {
    work.recover(entry.project, entry.id, isLive);
  } else {
    claims.recover(entry.project, entry.id, isLive);
  }
  return entry;
}
