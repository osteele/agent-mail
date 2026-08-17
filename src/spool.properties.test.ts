import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  type Message,
  type StoredMessage,
  appendMessageGuarded,
  isExpired,
  markAllMessagesRead,
  markMessagesRead,
  messageVisibleToSession,
  readMessages,
} from "./spool.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-spool-prop-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return project;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const baseOptions = {
  duplicateWindowSeconds: 0,
  messageRateLimitPerMinute: 0,
  defaultMessageTtlSeconds: null,
} as const;

// ---------------------------------------------------------------------------
// Default TTL and expiration
// ---------------------------------------------------------------------------

test("default TTL is applied to messages without an explicit expiresAt", () => {
  fc.assert(
    fc.property(
      fc.record({
        defaultTtlSeconds: fc.integer({ min: 60, max: 3_600 }),
        body: fc.string({ minLength: 1, maxLength: 20 }),
      }),
      ({ defaultTtlSeconds, body }) => {
        const project = makeProject();
        const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
        const msg: Message = {
          ts: iso(nowMs),
          from: "sender",
          project,
          message: body,
        };
        const result = appendMessageGuarded(
          msg,
          {
            ...baseOptions,
            defaultMessageTtlSeconds: defaultTtlSeconds,
          },
          nowMs,
        );
        expect(result.status).toBe("spooled");

        const stored = readMessages(project, { limit: 1 });
        expect(stored).toHaveLength(1);
        expect(stored[0].expiresAt).toBe(iso(nowMs + defaultTtlSeconds * 1000));
      },
    ),
    { seed: 42, numRuns: 30 },
  );
});

test("isExpired and messageVisibleToSession reject expired messages", () => {
  fc.assert(
    fc.property(
      fc.record({
        ttlSeconds: fc.integer({ min: 1, max: 600 }),
        body: fc.string({ minLength: 1, maxLength: 20 }),
        viewer: fc.string({ minLength: 1, maxLength: 10 }),
      }),
      ({ ttlSeconds, body, viewer }) => {
        const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
        const msg: Message = {
          ts: iso(nowMs),
          from: "sender",
          project: "/project",
          message: body,
          expiresAt: "2099-01-01T00:00:00.000Z",
          meta: { sessionId: "sender" },
        };
        expect(isExpired(msg, nowMs)).toBe(false);
        expect(messageVisibleToSession(msg, viewer)).toBe(true);

        const expired: Message = {
          ...msg,
          expiresAt: iso(nowMs - 1),
        };
        expect(isExpired(expired, nowMs)).toBe(true);
        expect(messageVisibleToSession(expired, viewer)).toBe(false);
      },
    ),
    { seed: 42, numRuns: 30 },
  );
});

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

function storedIds(messages: StoredMessage[]): string[] {
  return messages.map((msg) => msg.id);
}

test("mark read is idempotent and mark all read covers every message", () => {
  fc.assert(
    fc.property(
      fc.record({
        count: fc.integer({ min: 1, max: 10 }),
        markFirst: fc.integer({ min: 0, max: 10 }),
      }),
      ({ count, markFirst }) => {
        const project = makeProject();
        const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const result = appendMessageGuarded(
            {
              ts: iso(nowMs + i * 1000),
              from: "sender",
              project,
              message: `msg-${i}`,
            },
            baseOptions,
            nowMs,
          );
          if (result.status !== "spooled") {
            throw new Error(`expected spooled, got ${result.status}`);
          }
          ids.push(result.id);
        }

        const first = ids.slice(0, Math.min(markFirst, count));
        expect(markMessagesRead(project, first)).toBe(new Set(first).size);
        // Idempotent second mark.
        expect(markMessagesRead(project, first)).toBe(0);

        const unread = readMessages(project, { limit: 0, unreadOnly: true });
        const expectedUnread = ids.filter((id) => !first.includes(id));
        expect(storedIds(unread)).toEqual(expectedUnread);

        expect(markAllMessagesRead(project)).toBe(expectedUnread.length);
        expect(readMessages(project, { limit: 0, unreadOnly: true })).toEqual(
          [],
        );
      },
    ),
    { seed: 42, numRuns: 30 },
  );
});

test("readMessages respects limit and unreadOnly", () => {
  fc.assert(
    fc.property(
      fc.record({
        total: fc.integer({ min: 1, max: 20 }),
        readCount: fc.integer({ min: 0, max: 20 }),
        limit: fc.integer({ min: 0, max: 25 }),
        unreadOnly: fc.boolean(),
      }),
      ({ total, readCount, limit, unreadOnly }) => {
        const project = makeProject();
        const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
        const ids: string[] = [];
        for (let i = 0; i < total; i++) {
          const result = appendMessageGuarded(
            {
              ts: iso(nowMs + i * 1000),
              from: "sender",
              project,
              message: `msg-${i}`,
            },
            baseOptions,
            nowMs,
          );
          if (result.status !== "spooled") {
            throw new Error(`expected spooled, got ${result.status}`);
          }
          ids.push(result.id);
        }

        const toRead = ids.slice(0, Math.min(readCount, total));
        markMessagesRead(project, toRead);

        const options = { limit, unreadOnly };
        const result = readMessages(project, options);
        const candidates = ids
          .map((id, index) => ({ id, index }))
          .filter(({ id }) => !unreadOnly || !toRead.includes(id));

        const expected =
          limit === 0
            ? candidates.map(({ id }) => id)
            : candidates.slice(-limit).map(({ id }) => id);
        expect(storedIds(result)).toEqual(expected);
      },
    ),
    { seed: 42, numRuns: 50 },
  );
});

// ---------------------------------------------------------------------------
// Message visibility
// ---------------------------------------------------------------------------

test("messageVisibleToSession follows self-hide and direct-target rules", () => {
  fc.assert(
    fc.property(
      fc.record({
        author: fc.string({ minLength: 1, maxLength: 10 }),
        viewer: fc.string({ minLength: 1, maxLength: 10 }),
        toSession: fc.option(fc.string({ minLength: 1, maxLength: 10 }), {
          nil: undefined,
        }),
        isAudit: fc.boolean(),
        isExpired: fc.boolean(),
      }),
      ({ author, viewer, toSession, isAudit, isExpired }) => {
        const msg: Message = {
          ts: "2026-08-15T00:00:00.000Z",
          from: "sender",
          project: "/project",
          message: "hello",
          ...(isAudit ? { delivery: "audit" } : {}),
          ...(isExpired ? { expiresAt: "2026-08-14T00:00:00.000Z" } : {}),
          meta: { sessionId: author, ...(toSession ? { toSession } : {}) },
        };
        const visible = messageVisibleToSession(msg, viewer);

        if (isAudit || isExpired) {
          expect(visible).toBe(false);
          return;
        }
        if (toSession && toSession !== viewer) {
          expect(visible).toBe(false);
          return;
        }
        if (author === viewer && toSession !== viewer) {
          expect(visible).toBe(false);
          return;
        }
        expect(visible).toBe(true);
      },
    ),
    { seed: 42, numRuns: 100 },
  );
});
