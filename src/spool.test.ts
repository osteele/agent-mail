import { expect, test } from "bun:test";
import { type Message, messageVisibleToSession } from "./spool.ts";

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
