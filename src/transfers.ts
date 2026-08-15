/** Auditable, asynchronous ownership transfers for logical work leases. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TRANSFERS_DIR, canonicalProject } from "./paths.ts";
import { appendMessage } from "./spool.ts";
import {
  type WorkLease,
  type WorkOwner,
  WorkTransferSupersededError,
  sameWorkOwner,
  work,
} from "./work.ts";

export type TransferStatus =
  | "requested"
  | "accepted"
  | "declined"
  | "timed-out"
  | "superseded";

export interface WorkTransferRequest {
  version: 1;
  id: string;
  kind: "work";
  project: string;
  coordinationId: string;
  resourceType: string;
  resourceKey: string;
  expectedOwner: WorkOwner;
  expectedUpdatedAt: string;
  requester: WorkOwner;
  reason?: string;
  createdAt: string;
  deadline: string;
  status: TransferStatus;
  requestNotifiedAt?: string;
  resolutionNotifiedAt?: string;
  resolvedAt?: string;
  response?: string;
  actualOwner?: WorkOwner;
}

export interface TransferChange {
  request: WorkTransferRequest;
  changed: boolean;
}

/** Events that drive a work-transfer request through its lifecycle. */
export type TransferTransitionEvent =
  | { type: "decline"; response?: string }
  | {
      type: "settle";
      status: "accepted" | "timed-out";
      response?: string;
      result:
        | { kind: "transferred"; owner: WorkOwner }
        | { kind: "superseded"; actualOwner?: WorkOwner; reason: string };
    };

/** Pure transition table for a work-transfer request. Terminal states
 *  (`accepted`, `declined`, `timed-out`, `superseded`) are absorbing. */
export function transferTransition(
  currentStatus: TransferStatus,
  event: TransferTransitionEvent,
): {
  status: TransferStatus;
  response?: string;
  actualOwner?: WorkOwner;
} | null {
  if (currentStatus !== "requested") return null;
  switch (event.type) {
    case "decline":
      return { status: "declined", response: event.response };
    case "settle":
      if (event.result.kind === "transferred") {
        return {
          status: event.status,
          response: event.response,
          actualOwner: event.result.owner,
        };
      }
      return {
        status: "superseded",
        response: event.result.reason,
        actualOwner: event.result.actualOwner,
      };
  }
}

function validateText(
  value: string | undefined,
  name: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1000) throw new Error(`${name} is too long`);
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

export class TransferStore {
  constructor(
    private readonly root = TRANSFERS_DIR,
    private readonly workStore = work,
  ) {}

  private path(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private lockPath(key: string): string {
    return join(this.root, `${key}.lock`);
  }

  private withLock<T>(key: string, fn: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const lock = this.lockPath(key);
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let mtime: number;
        try {
          mtime = statSync(lock).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - mtime > 30_000) {
          try {
            rmdirSync(lock);
          } catch (removeError) {
            if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw removeError;
            }
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for transfer lock ${key}`);
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

  private write(request: WorkTransferRequest): void {
    mkdirSync(this.root, { recursive: true });
    const path = this.path(request.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, {
      flag: "wx",
    });
    try {
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  get(id: string): WorkTransferRequest | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as WorkTransferRequest;
  }

  list(project?: string): WorkTransferRequest[] {
    if (!existsSync(this.root)) return [];
    const canonical = project ? canonicalProject(project) : undefined;
    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(this.root, name), "utf8"),
          ) as WorkTransferRequest,
      )
      .filter((request) => !canonical || request.project === canonical)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markNotified(
    requestId: string,
    phase: "request" | "resolution",
  ): WorkTransferRequest {
    return this.withLock(`request-${requestId}`, () => {
      const request = this.get(requestId);
      if (!request) throw new Error(`transfer request not found: ${requestId}`);
      const stamped: WorkTransferRequest = {
        ...request,
        ...(phase === "request"
          ? { requestNotifiedAt: new Date().toISOString() }
          : { resolutionNotifiedAt: new Date().toISOString() }),
      };
      this.write(stamped);
      return stamped;
    });
  }

  request(
    lease: WorkLease,
    requester: WorkOwner,
    options: { reason?: string; timeoutSeconds?: number } = {},
  ): TransferChange {
    if (sameWorkOwner(lease.owner, requester)) {
      throw new Error(`work lease ${lease.id} already belongs to requester`);
    }
    const timeoutSeconds = options.timeoutSeconds ?? 300;
    if (
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 5 ||
      timeoutSeconds > 86_400
    ) {
      throw new Error("transfer timeout must be between 5 and 86400 seconds");
    }
    return this.withLock(`coordination-${lease.id}`, () => {
      const existing = this.list(lease.project).find(
        (request) =>
          request.status === "requested" &&
          request.coordinationId === lease.id &&
          sameWorkOwner(request.requester, requester) &&
          sameWorkOwner(request.expectedOwner, lease.owner) &&
          request.expectedUpdatedAt === lease.updatedAt,
      );
      if (existing) return { request: existing, changed: false };
      const createdAt = new Date().toISOString();
      const reason = validateText(options.reason, "transfer reason");
      const request: WorkTransferRequest = {
        version: 1,
        id: randomUUID(),
        kind: "work",
        project: lease.project,
        coordinationId: lease.id,
        resourceType: lease.resource.type,
        resourceKey: lease.resource.key,
        expectedOwner: lease.owner,
        expectedUpdatedAt: lease.updatedAt,
        requester,
        ...(reason ? { reason } : {}),
        createdAt,
        deadline: new Date(
          Date.parse(createdAt) + timeoutSeconds * 1000,
        ).toISOString(),
        status: "requested",
      };
      this.write(request);
      return { request, changed: true };
    });
  }

  respond(
    requestId: string,
    responder: WorkOwner,
    decision: "accept" | "decline",
    response?: string,
    nowMs = Date.now(),
  ): TransferChange {
    return this.withLock(`request-${requestId}`, () => {
      const request = this.get(requestId);
      if (!request) throw new Error(`transfer request not found: ${requestId}`);
      if (request.status !== "requested") {
        return { request, changed: false };
      }
      if (Date.parse(request.deadline) <= nowMs) {
        return this.settle(request, "timed-out");
      }
      if (!sameWorkOwner(request.expectedOwner, responder)) {
        throw new Error(
          `transfer request ${requestId} can only be answered by ${request.expectedOwner.label}`,
        );
      }
      if (decision === "decline") {
        const validatedResponse = validateText(response, "transfer response");
        const transition = transferTransition(request.status, {
          type: "decline",
          response: validatedResponse,
        });
        if (!transition) return { request, changed: false };
        const declined: WorkTransferRequest = {
          ...request,
          ...transition,
          resolvedAt: new Date().toISOString(),
        };
        this.write(declined);
        return { request: declined, changed: true };
      }
      return this.settle(request, "accepted", response);
    });
  }

  settleExpired(nowMs = Date.now()): WorkTransferRequest[] {
    const settled: WorkTransferRequest[] = [];
    for (const request of this.list()) {
      if (
        request.status !== "requested" ||
        Date.parse(request.deadline) > nowMs
      ) {
        continue;
      }
      const result = this.withLock(`request-${request.id}`, () => {
        const current = this.get(request.id);
        if (!current || current.status !== "requested") return undefined;
        return this.settle(current, "timed-out").request;
      });
      if (result) settled.push(result);
    }
    return settled;
  }

  private settle(
    request: WorkTransferRequest,
    status: "accepted" | "timed-out",
    response?: string,
  ): TransferChange {
    const validatedResponse = validateText(response, "transfer response");
    try {
      const lease = this.workStore.transfer(
        request.project,
        request.coordinationId,
        request.expectedOwner,
        request.expectedUpdatedAt,
        request.requester,
      );
      const transition = transferTransition(request.status, {
        type: "settle",
        status,
        response: validatedResponse,
        result: { kind: "transferred", owner: lease.owner },
      });
      if (!transition) return { request, changed: false };
      const settled: WorkTransferRequest = {
        ...request,
        ...transition,
        resolvedAt: new Date().toISOString(),
      };
      this.write(settled);
      return { request: settled, changed: true };
    } catch (error) {
      if (!(error instanceof WorkTransferSupersededError)) throw error;
      const actualOwner = this.workStore
        .list(request.project)
        .find((lease) => lease.id === request.coordinationId)?.owner;
      const transition = transferTransition(request.status, {
        type: "settle",
        status,
        result: {
          kind: "superseded",
          actualOwner,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      if (!transition) return { request, changed: false };
      const superseded: WorkTransferRequest = {
        ...request,
        ...transition,
        resolvedAt: new Date().toISOString(),
      };
      this.write(superseded);
      return { request: superseded, changed: true };
    }
  }
}

export const transfers = new TransferStore();

function transferMessage(
  request: WorkTransferRequest,
  message: string,
  toSession?: string,
): void {
  appendMessage({
    ts: new Date().toISOString(),
    from: "agent-mail-transfer",
    project: request.project,
    message,
    origin: {
      kind: "automation",
      transport: "internal",
      authority: "untrusted",
    },
    meta: {
      transferRequestId: request.id,
      coordinationId: request.coordinationId,
      ...(toSession ? { toSession } : {}),
    },
  });
}

export function publishTransferRequested(request: WorkTransferRequest): void {
  transferMessage(
    request,
    `${request.requester.label} requests ownership of ${request.resourceType}:${request.resourceKey} (${request.coordinationId}).${request.reason ? ` Reason: ${request.reason}.` : ""} Respond with respond_coordination_transfer request_id=${request.id} decision=accept|decline before ${request.deadline}; no response transfers the lease at the deadline.`,
    request.expectedOwner.sessionId,
  );
}

export function publishTransferResolved(request: WorkTransferRequest): void {
  const owner = request.actualOwner?.label ?? "no current owner";
  const detail = request.response ? ` ${request.response}` : "";
  const message = `Transfer request ${request.id} for ${request.resourceType}:${request.resourceKey} resolved ${request.status}; current owner: ${owner}.${detail}`;
  transferMessage(request, message, request.requester.sessionId);
  if (request.expectedOwner.sessionId !== request.requester.sessionId) {
    transferMessage(request, message, request.expectedOwner.sessionId);
  }
}

/** Retry durable notifications after a crash between spool append and status. */
export function flushTransferNotifications(): void {
  for (const request of transfers.list()) {
    if (request.status === "requested" && !request.requestNotifiedAt) {
      publishTransferRequested(request);
      transfers.markNotified(request.id, "request");
    } else if (
      request.status !== "requested" &&
      !request.resolutionNotifiedAt
    ) {
      publishTransferResolved(request);
      transfers.markNotified(request.id, "resolution");
    }
  }
}

export function findWorkLease(coordinationId: string): WorkLease {
  const matches = work.listAll().filter((lease) => lease.id === coordinationId);
  if (matches.length === 0) {
    throw new Error(`work lease not found: ${coordinationId}`);
  }
  if (matches.length > 1) {
    throw new Error(`work lease id is ambiguous: ${coordinationId}`);
  }
  return matches[0];
}
