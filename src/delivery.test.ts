import { expect, test } from "bun:test";
import { classifyFallback, withAttemptKey } from "./delivery.ts";
import type { Message } from "./spool.ts";

const BASE: Message = {
  ts: "2026-08-17T04:54:46.000Z",
  from: "agent-mail",
  project: "/Users/x/code/weft",
  message: "job done",
};

test("every attempt is stamped, leaving any caller key untouched", () => {
  // The two keys answer different questions, so the attempt token is minted
  // whether or not the caller asked for idempotency. Stamping only when the
  // caller supplied nothing would leave idempotent senders misreported.
  expect(withAttemptKey(BASE, "attempt-1").attemptKey).toBe("attempt-1");
  const withCallerKey = withAttemptKey(
    { ...BASE, idempotencyKey: "caller-key" },
    "attempt-1",
  );
  expect(withCallerKey.attemptKey).toBe("attempt-1");
  expect(withCallerKey.idempotencyKey).toBe("caller-key");
});

test("colliding with our own generated key means the message was delivered", () => {
  // The regression this guards: the daemon appended the message and then failed
  // to return its response, so the fallback re-read the shared spool and found
  // that very message. Reporting "duplicate suppressed" told the caller their
  // message had been dropped when it had in fact been sent.
  expect(
    classifyFallback({
      status: "duplicate",
      id: "msg-1",
      reason: "attempt-key",
    }),
  ).toEqual({ kind: "already-delivered", id: "msg-1" });
});

test("collisions that are not our own attempt stay duplicates", () => {
  // Same text from a separate call, or a caller's reused idempotency key.
  // Neither means this attempt's message landed, so neither may read as sent.
  for (const reason of ["signature", "idempotency-key"] as const) {
    expect(
      classifyFallback({ status: "duplicate", id: "msg-1", reason }),
    ).toEqual({ kind: "duplicate", id: "msg-1" });
  }
});

test("ordinary and rate-limited fallbacks pass through unchanged", () => {
  expect(
    classifyFallback({
      status: "spooled",
      id: "msg-2",
      path: "/tmp/spool.jsonl",
    }),
  ).toEqual({ kind: "spooled", id: "msg-2" });
  expect(
    classifyFallback({ status: "rate_limited", retryAfterSeconds: 7 }),
  ).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
});
