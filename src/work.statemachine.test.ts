import { afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { slowTest } from "./slowTests.ts";
import { TransferStore } from "./transfers.ts";
import {
  WorkConflictError,
  type WorkLease,
  type WorkOwner,
  type WorkState,
  WorkStore,
  type WorkTransferSupersededError,
} from "./work.ts";

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
  workStore: WorkStore;
  transferStore: TransferStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-work-sm-"));
  temporaryDirectories.push(root);
  const project = resolve(join(root, "project"));
  mkdirSync(project);
  const workRoot = resolve(join(root, "work"));
  const transferRoot = resolve(join(root, "transfers"));
  const workStore = new WorkStore(workRoot);
  const transferStore = new TransferStore(transferRoot, workStore);
  return { project, workStore, transferStore };
}

const OWNER_IDS = ["alice", "bob", "carol"] as const;
type OwnerId = (typeof OWNER_IDS)[number];

function makeOwner(id: OwnerId): WorkOwner {
  return { id, label: `agent ${id}` };
}

function resourceKey(resource: { type: string; key: string }): string {
  return `${resource.type}:${resource.key}`;
}

// ---------------------------------------------------------------------------
// Model-based work lease + transfer state-machine test
// ---------------------------------------------------------------------------

interface WorkModel {
  project: string;
  owners: Map<OwnerId, WorkOwner>;
  leases: Map<string, WorkLease>;
  resources: Map<string, string>; // type:key -> canonical lease id
  transfers: Map<string, import("./transfers.ts").WorkTransferRequest>;
}

interface WorkReal {
  project: string;
  workStore: WorkStore;
  transferStore: TransferStore;
}

class AcquireCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(
    readonly payload: {
      ownerId: OwnerId;
      resourceType: string;
      resourceKey: string;
      label?: string;
      state?: WorkState;
      activity?: string;
      deadConflict: boolean;
    },
  ) {}

  check(): boolean {
    return true;
  }

  run(m: WorkModel, r: WorkReal): void {
    const owner =
      m.owners.get(this.payload.ownerId) ?? makeOwner(this.payload.ownerId);
    m.owners.set(this.payload.ownerId, owner);
    const resource = {
      type: this.payload.resourceType,
      key: this.payload.resourceKey,
      ...(this.payload.label ? { label: this.payload.label } : {}),
    };
    const key = resourceKey(resource);
    const existingId = m.resources.get(key);
    const existing = existingId ? m.leases.get(existingId) : undefined;

    if (existing && existing.owner.id !== owner.id) {
      if (this.payload.deadConflict) {
        const lease = r.workStore.acquire(r.project, resource, owner, {
          ownerIsLive: () => false,
        });
        m.leases.set(lease.id, lease);
        m.resources.set(key, lease.id);
        // Remove any stale lease records for this resource.
        for (const [id, stale] of m.leases) {
          if (id !== lease.id && resourceKey(stale.resource) === key) {
            m.leases.delete(id);
          }
        }
        return;
      }
      expect(() =>
        r.workStore.acquire(r.project, resource, owner, {
          ownerIsLive: () => true,
        }),
      ).toThrow(WorkConflictError);
      return;
    }

    const lease = r.workStore.acquire(r.project, resource, owner, {
      ...(this.payload.state ? { state: this.payload.state } : {}),
      ...(this.payload.activity !== undefined
        ? { activity: this.payload.activity }
        : {}),
    });
    m.leases.set(lease.id, lease);
    m.resources.set(key, lease.id);
    for (const [id, stale] of m.leases) {
      if (id !== lease.id && resourceKey(stale.resource) === key) {
        m.leases.delete(id);
      }
    }
  }

  toString(): string {
    return `Acquire(${JSON.stringify(this.payload)})`;
  }
}

class UpdateCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(
    readonly payload: {
      actorId: OwnerId;
      state?: WorkState;
      activity?: string;
    },
  ) {}

  check(m: Readonly<WorkModel>): boolean {
    return m.leases.size > 0;
  }

  run(m: WorkModel, r: WorkReal): void {
    const [leaseId, lease] = [...m.leases.entries()][0];
    if (this.payload.actorId !== lease.owner.id) {
      expect(() =>
        r.workStore.update(r.project, leaseId, this.payload.actorId, {
          ...(this.payload.state ? { state: this.payload.state } : {}),
          ...(this.payload.activity !== undefined
            ? { activity: this.payload.activity }
            : {}),
        }),
      ).toThrow("only its owner can update it");
      return;
    }

    const updated = r.workStore.update(
      r.project,
      leaseId,
      this.payload.actorId,
      {
        ...(this.payload.state ? { state: this.payload.state } : {}),
        ...(this.payload.activity !== undefined
          ? { activity: this.payload.activity }
          : {}),
      },
    );
    m.leases.set(updated.id, updated);
  }

  toString(): string {
    return `Update(${JSON.stringify(this.payload)})`;
  }
}

class ReleaseCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(readonly payload: { actorId: OwnerId; targetOwnerId: OwnerId }) {}

  check(m: Readonly<WorkModel>): boolean {
    return [...m.leases.values()].some(
      (lease) => lease.owner.id === this.payload.targetOwnerId,
    );
  }

  run(m: WorkModel, r: WorkReal): void {
    const entries = [...m.leases.entries()];
    const match = entries.find(
      ([, l]) => l.owner.id === this.payload.targetOwnerId,
    );
    if (!match) return;
    const [leaseId, lease] = match;
    if (this.payload.actorId !== lease.owner.id) {
      expect(() =>
        r.workStore.release(r.project, leaseId, this.payload.actorId),
      ).toThrow("only its owner can release it");
      return;
    }

    r.workStore.release(r.project, leaseId, this.payload.actorId);
    m.leases.delete(leaseId);
    for (const [key, id] of m.resources) {
      if (id === leaseId) m.resources.delete(key);
    }
  }

  toString(): string {
    return `Release(${JSON.stringify(this.payload)})`;
  }
}

class RecoverCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(readonly payload: { ownerIsLive: boolean }) {}

  check(m: Readonly<WorkModel>): boolean {
    return m.leases.size > 0;
  }

  run(m: WorkModel, r: WorkReal): void {
    const [leaseId] = [...m.leases.entries()][0];
    if (this.payload.ownerIsLive) {
      expect(() => r.workStore.recover(r.project, leaseId, () => true)).toThrow(
        "live or cannot be verified offline",
      );
      return;
    }

    r.workStore.recover(r.project, leaseId, () => false);
    m.leases.delete(leaseId);
    for (const [key, id] of m.resources) {
      if (id === leaseId) m.resources.delete(key);
    }
  }

  toString(): string {
    return `Recover(${JSON.stringify(this.payload)})`;
  }
}

class ReleaseOwnerCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(readonly ownerId: OwnerId) {}

  check(): boolean {
    return true;
  }

  run(m: WorkModel, r: WorkReal): void {
    const count = r.workStore.releaseOwner(r.project, this.ownerId);
    let modelCount = 0;
    for (const [id, lease] of m.leases) {
      if (lease.owner.id === this.ownerId) {
        m.leases.delete(id);
        modelCount++;
      }
    }
    for (const [key, id] of m.resources) {
      if (!m.leases.has(id)) m.resources.delete(key);
    }
    expect(count).toBe(modelCount);
  }

  toString(): string {
    return `ReleaseOwner(${this.ownerId})`;
  }
}

class RequestTransferCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(
    readonly payload: {
      requesterId: OwnerId;
      timeoutSeconds: number;
      reason?: string;
    },
  ) {}

  check(m: Readonly<WorkModel>): boolean {
    return [...m.leases.values()].some(
      (lease) => lease.owner.id !== this.payload.requesterId,
    );
  }

  run(m: WorkModel, r: WorkReal): void {
    const lease = [...m.leases.values()].find(
      (l) => l.owner.id !== this.payload.requesterId,
    );
    if (!lease) return;
    const requester =
      m.owners.get(this.payload.requesterId) ??
      makeOwner(this.payload.requesterId);
    m.owners.set(this.payload.requesterId, requester);

    const existing = [...m.transfers.values()].find(
      (request) =>
        request.status === "requested" &&
        request.coordinationId === lease.id &&
        request.requester.id === requester.id &&
        request.expectedOwner.id === lease.owner.id &&
        request.expectedRevision === lease.revision,
    );

    const result = r.transferStore.request(lease, requester, {
      timeoutSeconds: this.payload.timeoutSeconds,
      ...(this.payload.reason ? { reason: this.payload.reason } : {}),
    });
    expect(result.request.coordinationId).toBe(lease.id);
    m.transfers.set(result.request.id, result.request);
    if (existing) {
      expect(result.changed).toBe(false);
      expect(result.request.id).toBe(existing.id);
    } else {
      expect(result.changed).toBe(true);
    }
  }

  toString(): string {
    return `RequestTransfer(${JSON.stringify(this.payload)})`;
  }
}

class RespondTransferCommand implements fc.Command<WorkModel, WorkReal> {
  constructor(
    readonly payload: {
      responderId: OwnerId;
      decision: "accept" | "decline";
      expired: boolean;
      response?: string;
    },
  ) {}

  check(m: Readonly<WorkModel>): boolean {
    return [...m.transfers.values()].some(
      (request) => request.status === "requested",
    );
  }

  run(m: WorkModel, r: WorkReal): void {
    const request = [...m.transfers.values()].find(
      (req) => req.status === "requested",
    );
    if (!request) return;

    if (this.payload.responderId !== request.expectedOwner.id) {
      expect(() =>
        r.transferStore.respond(
          request.id,
          m.owners.get(this.payload.responderId) ??
            makeOwner(this.payload.responderId),
          this.payload.decision,
          this.payload.response,
        ),
      ).toThrow("can only be answered by");
      return;
    }

    const nowMs = this.payload.expired
      ? Date.parse(request.deadline) + 1
      : Date.parse(request.deadline) - 1;
    const responder =
      m.owners.get(this.payload.responderId) ??
      makeOwner(this.payload.responderId);
    m.owners.set(this.payload.responderId, responder);

    const lease = m.leases.get(request.coordinationId);
    const willTransfer =
      (this.payload.decision === "accept" || this.payload.expired) &&
      lease !== undefined &&
      lease.owner.id === request.expectedOwner.id &&
      lease.revision === request.expectedRevision;

    const result = r.transferStore.respond(
      request.id,
      responder,
      this.payload.decision,
      this.payload.response,
      nowMs,
    );
    m.transfers.set(result.request.id, result.request);

    if (this.payload.decision === "decline" && !this.payload.expired) {
      expect(result.request.status).toBe("declined");
      return;
    }

    // accept, or any decision after the deadline, goes through settle.
    if (willTransfer) {
      expect(result.request.status).toBe(
        this.payload.expired ? "timed-out" : "accepted",
      );
      const transferred = r.workStore
        .list(r.project)
        .find((l) => l.id === request.coordinationId);
      expect(transferred).toBeDefined();
      if (!transferred) return;
      expect(transferred.owner.id).toBe(request.requester.id);
      m.leases.set(transferred.id, transferred);
    } else {
      expect(result.request.status).toBe("superseded");
    }
  }

  toString(): string {
    return `RespondTransfer(${JSON.stringify(this.payload)})`;
  }
}

class SettleExpiredCommand implements fc.Command<WorkModel, WorkReal> {
  check(m: Readonly<WorkModel>): boolean {
    return [...m.transfers.values()].some(
      (request) => request.status === "requested",
    );
  }

  run(m: WorkModel, r: WorkReal): void {
    const deadlines = [...m.transfers.values()]
      .filter((request) => request.status === "requested")
      .map((request) => Date.parse(request.deadline));
    const nowMs = Math.max(...deadlines) + 1;
    const settled = r.transferStore.settleExpired(nowMs);
    for (const request of settled) {
      m.transfers.set(request.id, request);
      if (request.status === "timed-out" || request.status === "accepted") {
        const lease = r.workStore
          .list(r.project)
          .find((l) => l.id === request.coordinationId);
        if (lease && request.actualOwner) {
          expect(lease.owner.id).toBe(request.actualOwner.id);
          m.leases.set(lease.id, lease);
        }
      }
    }
  }

  toString(): string {
    return "SettleExpired()";
  }
}

function assertInvariants(m: WorkModel, r: WorkReal): void {
  const realLeases = r.workStore.list(r.project);
  const modelLeaseIds = new Set(m.leases.keys());
  const realLeaseIds = new Set(realLeases.map((lease) => lease.id));
  expect(realLeaseIds).toEqual(modelLeaseIds);

  // Each modeled resource maps to a real lease with matching resource.
  for (const [key, leaseId] of m.resources) {
    const lease = m.leases.get(leaseId);
    expect(lease).toBeDefined();
    if (!lease) continue;
    expect(resourceKey(lease.resource)).toBe(key);
  }

  // No duplicate active resources in real leases.
  const seenResources = new Set<string>();
  for (const lease of realLeases) {
    const key = resourceKey(lease.resource);
    expect(seenResources.has(key)).toBe(false);
    seenResources.add(key);
  }

  // Transfer model matches real store.
  const realTransfers = r.transferStore.list(r.project);
  expect(realTransfers.length).toBe(m.transfers.size);
  const realTransferIds = new Set(realTransfers.map((request) => request.id));
  expect(realTransferIds).toEqual(new Set(m.transfers.keys()));
}

const ownerArb = fc.constantFrom(...OWNER_IDS);
const resourceTypeArb = fc.constantFrom("research-plan", "task", "audit");
const resourceKeyArb = fc.constantFrom("alpha", "beta", "gamma");
const workStateArb = fc.constantFrom<WorkState>("working", "waiting");

const acquireArb = fc
  .record({
    ownerId: ownerArb,
    resourceType: resourceTypeArb,
    resourceKey: resourceKeyArb,
    label: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
    state: fc.option(workStateArb),
    activity: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
    deadConflict: fc.boolean(),
  })
  .map(
    (payload) =>
      new AcquireCommand({
        ...payload,
        label: payload.label ?? undefined,
        state: payload.state ?? undefined,
        activity: payload.activity ?? undefined,
      }),
  );

const updateArb = fc
  .record({
    actorId: ownerArb,
    state: fc.option(workStateArb),
    activity: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
  })
  .map(
    (payload) =>
      new UpdateCommand({
        ...payload,
        state: payload.state ?? undefined,
        activity: payload.activity ?? undefined,
      }),
  );

const releaseArb = fc
  .record({ actorId: ownerArb, targetOwnerId: ownerArb })
  .map((payload) => new ReleaseCommand(payload));

const recoverArb = fc
  .boolean()
  .map((ownerIsLive) => new RecoverCommand({ ownerIsLive }));

const releaseOwnerArb = ownerArb.map(
  (ownerId) => new ReleaseOwnerCommand(ownerId),
);

const requestTransferArb = fc
  .record({
    requesterId: ownerArb,
    timeoutSeconds: fc.integer({ min: 5, max: 60 }),
    reason: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
  })
  .map(
    (payload) =>
      new RequestTransferCommand({
        ...payload,
        reason: payload.reason ?? undefined,
      }),
  );

const respondTransferArb = fc
  .record({
    responderId: ownerArb,
    decision: fc.constantFrom<"accept" | "decline">("accept", "decline"),
    expired: fc.boolean(),
    response: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
  })
  .map(
    (payload) =>
      new RespondTransferCommand({
        ...payload,
        response: payload.response ?? undefined,
      }),
  );

const commandArb = fc.oneof(
  { weight: 5, arbitrary: acquireArb },
  { weight: 2, arbitrary: updateArb },
  { weight: 2, arbitrary: releaseArb },
  { weight: 1, arbitrary: recoverArb },
  { weight: 1, arbitrary: releaseOwnerArb },
  { weight: 2, arbitrary: requestTransferArb },
  { weight: 2, arbitrary: respondTransferArb },
  { weight: 1, arbitrary: fc.constant(new SettleExpiredCommand()) },
);

const seed: Parameters<typeof fc.assert>[1] = { seed: 42 };

slowTest(
  "work lease + transfer state machine preserves ownership invariants",
  () => {
    fc.assert(
      fc.property(fc.commands([commandArb], { size: "+1" }), (cmds) => {
        const { project, workStore, transferStore } = makeProject();
        const initialModel: WorkModel = {
          project,
          owners: new Map(),
          leases: new Map(),
          resources: new Map(),
          transfers: new Map(),
        };
        const initialReal: WorkReal = { project, workStore, transferStore };
        const setup = () => ({ model: initialModel, real: initialReal });
        fc.modelRun(setup, cmds);
        assertInvariants(initialModel, initialReal);
      }),
      { ...seed, numRuns: 30 },
    );
  },
);
