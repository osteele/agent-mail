import { expect, test } from "bun:test";
import {
  type AdmissionOptions,
  type Message,
  admissionDecision,
  isExpired,
  messageVisibleToSession,
  shouldEchoMessageToSlack,
} from "./spool.ts";

const base: Message = {
  ts: "2026-07-22T00:00:00.000Z",
  from: "/project/a",
  project: "/project/b",
  message: "hello",
};

test("messageVisibleToSession hides self-authored shared-spool mail", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender" } },
      "sender",
    ),
  ).toBe(false);
});

test("messageVisibleToSession shows mail from other sessions", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender" } },
      "recipient",
    ),
  ).toBe(true);
});

test("messageVisibleToSession honors direct session targets", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "recipient" } },
      "bystander",
    ),
  ).toBe(false);
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "recipient" } },
      "recipient",
    ),
  ).toBe(true);
});

test("messageVisibleToSession shows explicitly self-targeted mail", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "sender" } },
      "sender",
    ),
  ).toBe(true);
});

const admission: AdmissionOptions = {
  duplicateWindowSeconds: 10,
  messageRateLimitPerMinute: 2,
  defaultMessageTtlSeconds: null,
};

test("admission deduplicates retry keys and recent identical bodies", () => {
  const now = Date.parse("2026-07-22T00:00:10.000Z");
  const prior: Message = {
    ...base,
    id: "prior",
    ts: "2026-07-22T00:00:05.000Z",
    idempotencyKey: "job-42",
  };
  expect(
    admissionDecision(
      [prior],
      { ...base, idempotencyKey: "job-42" },
      admission,
      now,
    ),
  ).toEqual({ status: "duplicate", id: "prior" });
  expect(admissionDecision([prior], { ...base }, admission, now)).toEqual({
    status: "duplicate",
    id: "prior",
  });
});

test("admission rate-limits one sender without blocking another", () => {
  const now = Date.parse("2026-07-22T00:01:00.000Z");
  const recent = [
    { ...base, id: "one", ts: "2026-07-22T00:00:30.000Z", message: "one" },
    { ...base, id: "two", ts: "2026-07-22T00:00:45.000Z", message: "two" },
  ];
  expect(
    admissionDecision(recent, { ...base, message: "three" }, admission, now),
  ).toEqual({ status: "rate_limited", retryAfterSeconds: 30 });
  expect(
    admissionDecision(
      recent,
      { ...base, from: "/project/c", message: "three" },
      admission,
      now,
    ),
  ).toEqual({ status: "accept" });
});

test("zero disables body deduplication and rate limiting", () => {
  const now = Date.parse("2026-07-22T00:01:00.000Z");
  const prior = {
    ...base,
    id: "prior",
    ts: "2026-07-22T00:00:59.000Z",
  };
  expect(
    admissionDecision(
      [prior],
      base,
      {
        ...admission,
        duplicateWindowSeconds: 0,
        messageRateLimitPerMinute: 0,
      },
      now,
    ),
  ).toEqual({ status: "accept" });
});

test("audit and expired messages are not visible to a receiving session", () => {
  const now = Date.parse("2026-07-22T00:00:10.000Z");
  expect(
    messageVisibleToSession({ ...base, delivery: "audit" }, "receiver"),
  ).toBe(false);
  const expired = { ...base, expiresAt: "2026-07-22T00:00:09.000Z" };
  expect(isExpired(expired, now)).toBe(true);
});

test("Slack echo defaults on and can be suppressed per message", () => {
  expect(shouldEchoMessageToSlack(base)).toBe(true);
  expect(shouldEchoMessageToSlack({ ...base, slackEcho: true })).toBe(true);
  expect(shouldEchoMessageToSlack({ ...base, slackEcho: false })).toBe(false);
});
