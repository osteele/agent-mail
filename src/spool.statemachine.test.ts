import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  deliverNewMessage,
  pendingHeldIds,
  settleHeldMessages,
} from "./delivery.ts";
import type { InboundPolicy } from "./registry.ts";
import {
  type DeliveryReceipt,
  type Message,
  type StoredMessage,
  admissionDecision,
  appendMessageGuarded,
  isExpired,
  markMessagesRead,
  messageVisibleToSession,
  readMessages,
} from "./spool.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSIONS = ["alice", "bob", "carol"] as const;
type SessionId = (typeof SESSIONS)[number];

interface SpoolOptions {
  duplicateWindowSeconds: number;
  messageRateLimitPerMinute: number;
  defaultMessageTtlSeconds: number | null;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-sm-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return project;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function latestReceiptFor(
  receipts: DeliveryReceipt[],
  messageId: string,
  sessionId: string,
): DeliveryReceipt | undefined {
  let latest: DeliveryReceipt | undefined;
  for (const r of receipts) {
    if (r.messageId !== messageId || r.sessionId !== sessionId) continue;
    if (!latest || r.ts > latest.ts) latest = r;
  }
  return latest;
}

function deliveryState(
  receipts: DeliveryReceipt[],
  messageId: string,
  sessionId: string,
): "spooled" | "held" | "pushed" | "read" | "refused" | "expired" | undefined {
  const r = latestReceiptFor(receipts, messageId, sessionId);
  return r?.status;
}

// ---------------------------------------------------------------------------
// Model-based delivery state-machine test
// ---------------------------------------------------------------------------

interface DeliveryModel {
  project: string;
  nextMessageId: number;
  messages: Map<string, Message & { id: string }>;
  pending: Map<SessionId, Set<string>>;
  receipts: DeliveryReceipt[];
  policies: Map<SessionId, InboundPolicy>;
  heldLimits: Map<SessionId, number>;
  nowMs: number;
}

interface DeliveryReal {
  project: string;
  nextMessageId: number;
  messages: Map<string, Message & { id: string }>;
  pending: Map<SessionId, Set<string>>;
  receipts: DeliveryReceipt[];
  policies: Map<SessionId, InboundPolicy>;
  heldLimits: Map<SessionId, number>;
  nowMs: number;
}

interface SendPayload {
  from: SessionId;
  body: string;
  toSession?: SessionId;
  ttlSeconds?: number;
}

class SendMessageCommand implements fc.Command<DeliveryModel, DeliveryReal> {
  constructor(readonly payload: SendPayload) {}

  check(): boolean {
    return true;
  }

  run(m: DeliveryModel, r: DeliveryReal): void {
    const { from, body, toSession, ttlSeconds } = this.payload;
    const id = String(m.nextMessageId++);
    r.nextMessageId++;
    const msg: Message & { id: string } = {
      id,
      ts: iso(m.nowMs),
      from,
      project: m.project,
      message: body,
      meta: { sessionId: from, ...(toSession ? { toSession } : {}) },
      ...(ttlSeconds !== undefined
        ? { expiresAt: iso(m.nowMs + ttlSeconds * 1000) }
        : {}),
    };
    m.messages.set(id, msg);
    r.messages.set(id, msg);

    m.receipts.push({
      messageId: id,
      project: m.project,
      ts: iso(m.nowMs),
      status: "spooled",
    });
    r.receipts.push({
      messageId: id,
      project: r.project,
      ts: iso(r.nowMs),
      status: "spooled",
    });

    for (const sessionId of SESSIONS) {
      if (toSession && toSession !== sessionId) continue;
      let mPending = m.pending.get(sessionId);
      if (!mPending) {
        mPending = new Set();
        m.pending.set(sessionId, mPending);
      }
      let rPending = r.pending.get(sessionId);
      if (!rPending) {
        rPending = new Set();
        r.pending.set(sessionId, rPending);
      }
      mPending.add(id);
      rPending.add(id);
    }
  }

  toString(): string {
    return `SendMessage(${JSON.stringify(this.payload)})`;
  }
}

class PollSessionCommand implements fc.Command<DeliveryModel, DeliveryReal> {
  constructor(readonly sessionId: SessionId) {}

  check(): boolean {
    return true;
  }

  run(m: DeliveryModel, r: DeliveryReal): void {
    const ids = [...(m.pending.get(this.sessionId) ?? [])];
    for (const id of ids) {
      const msg = m.messages.get(id);
      if (!msg) continue;
      m.receipts = deliverNewMessage(
        m.project,
        msg,
        this.sessionId,
        m.policies.get(this.sessionId) ?? "accept",
        false,
        true,
        m.heldLimits.get(this.sessionId) ?? 1,
        m.receipts,
        m.nowMs,
      );
      r.receipts = deliverNewMessage(
        r.project,
        msg,
        this.sessionId,
        r.policies.get(this.sessionId) ?? "accept",
        false,
        true,
        r.heldLimits.get(this.sessionId) ?? 1,
        r.receipts,
        r.nowMs,
      );
      m.pending.get(this.sessionId)?.delete(id);
      r.pending.get(this.sessionId)?.delete(id);
    }
  }

  toString(): string {
    return `PollSession(${this.sessionId})`;
  }
}

class SetPolicyCommand implements fc.Command<DeliveryModel, DeliveryReal> {
  constructor(
    readonly sessionId: SessionId,
    readonly policy: InboundPolicy,
  ) {}

  check(): boolean {
    return true;
  }

  run(m: DeliveryModel, r: DeliveryReal): void {
    m.policies.set(this.sessionId, this.policy);
    r.policies.set(this.sessionId, this.policy);
    this.settle(m);
    this.settle(r);
  }

  private settle(state: DeliveryModel | DeliveryReal): void {
    const byId = new Map(
      [...state.messages.values()].map((msg) => [msg.id, msg]),
    );
    state.receipts = settleHeldMessages(
      state.project,
      this.sessionId,
      this.policy,
      false,
      true,
      byId,
      state.receipts,
      state.nowMs,
    );
  }

  toString(): string {
    return `SetPolicy(${this.sessionId}, ${this.policy})`;
  }
}

class MarkReadCommand implements fc.Command<DeliveryModel, DeliveryReal> {
  constructor(
    readonly sessionId: SessionId,
    readonly messageIds: string[],
  ) {}

  check(m: Readonly<DeliveryModel>): boolean {
    return this.messageIds.every((id) => m.messages.has(id));
  }

  run(m: DeliveryModel, r: DeliveryReal): void {
    for (const messageId of this.messageIds) {
      const msg = m.messages.get(messageId);
      if (!msg) continue;
      const status = deliveryState(m.receipts, messageId, this.sessionId);
      if (status !== "held" && status !== "pushed") continue;
      m.receipts.push({
        messageId,
        project: m.project,
        ts: iso(m.nowMs),
        status: "read",
        sessionId: this.sessionId,
      });
      r.receipts.push({
        messageId,
        project: r.project,
        ts: iso(r.nowMs),
        status: "read",
        sessionId: this.sessionId,
      });
    }
  }

  toString(): string {
    return `MarkRead(${this.sessionId}, ${JSON.stringify(this.messageIds)})`;
  }
}

class AdvanceTimeCommand implements fc.Command<DeliveryModel, DeliveryReal> {
  constructor(readonly deltaMs: number) {}

  check(): boolean {
    return this.deltaMs >= 0;
  }

  run(m: DeliveryModel, r: DeliveryReal): void {
    m.nowMs += this.deltaMs;
    r.nowMs += this.deltaMs;
  }

  toString(): string {
    return `AdvanceTime(${this.deltaMs})`;
  }
}

function assertReceiptsEqual(
  model: DeliveryReceipt[],
  real: DeliveryReceipt[],
): void {
  expect(
    real.map((r) => [r.messageId, r.sessionId, r.status, r.detail]),
  ).toEqual(model.map((r) => [r.messageId, r.sessionId, r.status, r.detail]));
}

function assertInvariants(state: DeliveryModel | DeliveryReal): void {
  for (const sessionId of SESSIONS) {
    const held = pendingHeldIds(state.receipts, sessionId);
    const limit = state.heldLimits.get(sessionId) ?? 1;
    expect(held.length).toBeLessThanOrEqual(limit);

    for (const [messageId, msg] of state.messages) {
      const status = deliveryState(state.receipts, messageId, sessionId);

      const selfAddressed = msg.meta?.toSession === sessionId;
      const sameAuthor = msg.meta?.sessionId === sessionId;
      if (sameAuthor && !selfAddressed) {
        expect(status === undefined || status === "expired").toBe(true);
        continue;
      }

      const toSession = msg.meta?.toSession;
      if (toSession && toSession !== sessionId) {
        expect(status === undefined || status === "expired").toBe(true);
        continue;
      }

      if (status && isExpired(msg, state.nowMs)) {
        expect(["expired", "refused", "read"]).toContain(status);
      }

      if (status === "read") {
        const prior = state.receipts.some(
          (r) =>
            r.messageId === messageId &&
            r.sessionId === sessionId &&
            (r.status === "held" || r.status === "pushed"),
        );
        expect(prior).toBe(true);
      }

      if (status && ["pushed", "read", "refused", "expired"].includes(status)) {
        const latest = latestReceiptFor(state.receipts, messageId, sessionId);
        expect(latest?.status).toBe(status);
      }
    }
  }
}

const sessionArb = fc.constantFrom(...SESSIONS);
const policyArb = fc.constantFrom<InboundPolicy>("accept", "hold", "refuse");

const sendCommandArb = fc
  .record({
    from: sessionArb,
    body: fc.string({ minLength: 1, maxLength: 20 }),
    toSession: fc.option(sessionArb, { nil: undefined }),
    ttlSeconds: fc.option(fc.integer({ min: 1, max: 3600 }), {
      nil: undefined,
    }),
  })
  .map((payload) => new SendMessageCommand(payload));

const commandArb = fc.oneof(
  { weight: 5, arbitrary: sendCommandArb },
  { weight: 5, arbitrary: sessionArb.map((s) => new PollSessionCommand(s)) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(sessionArb, policyArb)
      .map(([s, p]) => new SetPolicyCommand(s, p)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        sessionArb,
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
          minLength: 0,
          maxLength: 3,
        }),
      )
      .map(([s, ids]) => new MarkReadCommand(s, ids)),
  },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 0, max: 120_000 })
      .map((d) => new AdvanceTimeCommand(d)),
  },
);

const seed: Parameters<typeof fc.assert>[1] = { seed: 42 };

test("delivery state machine preserves receipt invariants", () => {
  fc.assert(
    fc.property(fc.commands([commandArb], { size: "+1" }), (cmds) => {
      const project = makeProject();
      const initialModel: DeliveryModel = {
        project,
        nextMessageId: 1,
        messages: new Map(),
        pending: new Map(),
        receipts: [],
        policies: new Map(),
        heldLimits: new Map(),
        nowMs: Date.parse("2026-08-15T00:00:00.000Z"),
      };
      const initialReal: DeliveryReal = {
        project,
        nextMessageId: 1,
        messages: new Map(),
        pending: new Map(),
        receipts: [],
        policies: new Map(),
        heldLimits: new Map(),
        nowMs: initialModel.nowMs,
      };
      const setup = () => ({ model: initialModel, real: initialReal });
      fc.modelRun(setup, cmds);
      assertInvariants(initialModel);
      assertReceiptsEqual(initialModel.receipts, initialReal.receipts);
    }),
    { ...seed, numRuns: 50 },
  );
});

test("expired messages are not delivered as pushed or held", () => {
  fc.assert(
    fc.property(
      fc.record({
        ttl: fc.integer({ min: 1, max: 60 }),
        delay: fc.integer({ min: 1, max: 120 }),
        sender: sessionArb,
        target: sessionArb,
        body: fc.string({ minLength: 1, maxLength: 20 }),
      }),
      ({ ttl, delay, sender, target, body }) => {
        const project = makeProject();
        const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
        const msg: Message & { id: string } = {
          id: "msg-1",
          ts: iso(nowMs),
          from: sender,
          project,
          message: body,
          meta: { sessionId: sender },
          expiresAt: iso(nowMs + ttl * 1000),
        };
        const receipts = deliverNewMessage(
          project,
          msg,
          target,
          "accept",
          false,
          true,
          1,
          [],
          nowMs + (ttl + delay) * 1000,
        );
        const status = deliveryState(receipts, "msg-1", target);
        expect(status).toBe("expired");
      },
    ),
    { ...seed, numRuns: 50 },
  );
});

// ---------------------------------------------------------------------------
// Spool admission/read state-machine test
// ---------------------------------------------------------------------------

interface SpoolModel {
  project: string;
  options: SpoolOptions;
  messages: StoredMessage[];
  readIds: Set<string>;
  nowMs: number;
}

interface SpoolReal {
  project: string;
  options: SpoolOptions;
  nowMs: number;
}

interface SpoolSendPayload {
  from: string;
  body: string;
  idempotencyKey?: string;
}

class SpoolSendCommand implements fc.Command<SpoolModel, SpoolReal> {
  constructor(readonly payload: SpoolSendPayload) {}

  check(): boolean {
    return true;
  }

  run(m: SpoolModel, r: SpoolReal): void {
    const msg: Message = {
      ts: iso(m.nowMs),
      from: this.payload.from,
      project: m.project,
      message: this.payload.body,
      ...(this.payload.idempotencyKey
        ? { idempotencyKey: this.payload.idempotencyKey }
        : {}),
    };
    const result = appendMessageGuarded(msg, r.options, r.nowMs);

    const recent = m.messages.slice(-100);
    const decision = admissionDecision(recent, msg, m.options, m.nowMs);

    const expectedStatus =
      decision.status === "accept" ? "spooled" : decision.status;
    expect(result.status).toBe(expectedStatus);
    if (result.status === "spooled") {
      m.messages.push({ ...msg, id: result.id, read: false });
    }
  }

  toString(): string {
    return `SpoolSend(${JSON.stringify(this.payload)})`;
  }
}

class SpoolMarkReadCommand implements fc.Command<SpoolModel, SpoolReal> {
  constructor(readonly ids: string[]) {}

  check(m: Readonly<SpoolModel>): boolean {
    return this.ids.every((id) => m.messages.some((msg) => msg.id === id));
  }

  run(m: SpoolModel, r: SpoolReal): void {
    markMessagesRead(r.project, this.ids);
    for (const id of this.ids) {
      m.readIds.add(id);
    }
  }

  toString(): string {
    return `SpoolMarkRead(${JSON.stringify(this.ids)})`;
  }
}

class SpoolAdvanceTimeCommand implements fc.Command<SpoolModel, SpoolReal> {
  constructor(readonly deltaMs: number) {}

  check(): boolean {
    return this.deltaMs >= 0;
  }

  run(m: SpoolModel, r: SpoolReal): void {
    m.nowMs += this.deltaMs;
    r.nowMs += this.deltaMs;
  }

  toString(): string {
    return `SpoolAdvanceTime(${this.deltaMs})`;
  }
}

class SpoolCheckInboxCommand implements fc.Command<SpoolModel, SpoolReal> {
  constructor(readonly unreadOnly: boolean) {}

  check(): boolean {
    return true;
  }

  run(m: SpoolModel, r: SpoolReal): void {
    const real = readMessages(r.project, {
      limit: 0,
      unreadOnly: this.unreadOnly,
    });
    const model = m.messages.filter((msg) => {
      if (this.unreadOnly && m.readIds.has(msg.id)) return false;
      return !isExpired(msg, m.nowMs);
    });
    expect(real.map((msg) => msg.id)).toEqual(model.map((msg) => msg.id));
  }

  toString(): string {
    return `SpoolCheckInbox(${this.unreadOnly})`;
  }
}

const spoolSendArb = fc
  .record({
    from: fc.string({ minLength: 1, maxLength: 10 }),
    body: fc.string({ minLength: 1, maxLength: 20 }),
    idempotencyKey: fc.option(fc.string({ minLength: 1, maxLength: 10 }), {
      nil: undefined,
    }),
  })
  .map((payload) => new SpoolSendCommand(payload));

const spoolCommandArb = fc.oneof(
  { weight: 5, arbitrary: spoolSendArb },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.string({ minLength: 1, maxLength: 16 }), {
        minLength: 0,
        maxLength: 3,
      })
      .map((ids) => new SpoolMarkReadCommand(ids)),
  },
  {
    weight: 2,
    arbitrary: fc.boolean().map((u) => new SpoolCheckInboxCommand(u)),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 0, max: 120_000 })
      .map((d) => new SpoolAdvanceTimeCommand(d)),
  },
);

test("spool admission and read state preserve invariants", () => {
  fc.assert(
    fc.property(fc.commands([spoolCommandArb], { size: "+1" }), (cmds) => {
      const project = makeProject();
      const options: SpoolOptions = {
        duplicateWindowSeconds: 30,
        messageRateLimitPerMinute: 3,
        defaultMessageTtlSeconds: null,
      };
      const initialModel: SpoolModel = {
        project,
        options,
        messages: [],
        readIds: new Set(),
        nowMs: Date.parse("2026-08-15T00:00:00.000Z"),
      };
      const initialReal: SpoolReal = {
        project,
        options,
        nowMs: initialModel.nowMs,
      };
      const setup = () => ({ model: initialModel, real: initialReal });
      fc.modelRun(setup, cmds);
    }),
    { ...seed, numRuns: 50 },
  );
});
