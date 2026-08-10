import { expect, test } from "bun:test";
import type { Registration } from "./registry.ts";
import type { ClaudeSessionMeta } from "./sessions.ts";
import { formatSlackEcho } from "./slackEcho.ts";
import type { Message } from "./spool.ts";

const SOURCE = "/projects/llm-performance-models";
const TARGET = "/projects/adaptive-escalation";
const TS = "2026-08-10T02:20:00.000Z";

function registration(cwd: string, sessionId: string): Registration {
  return { cwd, sessionId, pid: 1, started: TS };
}

function sessions(entries: [string, string][]): Map<string, ClaudeSessionMeta> {
  return new Map(
    entries.map(([id, name]) => [id, { name, nameSource: "user" }]),
  );
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    ts: TS,
    from: SOURCE,
    project: SOURCE,
    message: "hello",
    meta: { sessionId: "sender" },
    ...overrides,
  };
}

test("same-project direct mail names both sessions compactly", () => {
  const formatted = formatSlackEcho(
    message({ meta: { sessionId: "sender", toSession: "recipient" } }),
    [registration(SOURCE, "sender"), registration(SOURCE, "recipient")],
    sessions([
      ["sender", "hia"],
      ["recipient", "nia"],
    ]),
  );
  expect(formatted.sectionText).toContain(
    "*llm-performance-models* · `hia → nia`",
  );
  expect(formatted.fallbackText).toBe(
    "📬 llm-performance-models · hia → nia: hello",
  );
  expect(formatted.listening).toBe(true);
});

test("direct mail keeps its target name after the recipient disconnects", () => {
  const formatted = formatSlackEcho(
    message({ meta: { sessionId: "sender", toSession: "recipient" } }),
    [registration(SOURCE, "sender")],
    sessions([
      ["sender", "hia"],
      ["recipient", "nia"],
    ]),
  );
  expect(formatted.sectionText).toContain("`hia → nia`");
  expect(formatted.listening).toBe(false);
});

test("broadcast shows a sorted, capped snapshot and excludes the sender", () => {
  const registrations = [
    registration(SOURCE, "sender"),
    ...["zia", "bia", "nia", "ram", "lim"].map((id) =>
      registration(SOURCE, id),
    ),
  ];
  const formatted = formatSlackEcho(
    message(),
    registrations,
    sessions([
      ["sender", "hia"],
      ["zia", "zia"],
      ["bia", "bia"],
      ["nia", "nia"],
      ["ram", "ram"],
      ["lim", "lim"],
    ]),
  );
  expect(formatted.sectionText).toContain(
    "*llm-performance-models* · `hia → all` _(live: `bia`, `lim`, `nia` +2)_",
  );
  expect(formatted.sectionText).not.toContain("live: `hia`");
});

test("cross-project routes keep both project names", () => {
  const formatted = formatSlackEcho(
    message({
      project: TARGET,
      meta: { sessionId: "sender", toSession: "recipient" },
    }),
    [registration(TARGET, "recipient")],
    sessions([
      ["sender", "hia"],
      ["recipient", "lim"],
    ]),
  );
  expect(formatted.sectionText).toContain(
    "*llm-performance-models* `hia` → *adaptive-escalation* `lim`",
  );
});

test("route labels are escaped without losing deliberate names", () => {
  const formatted = formatSlackEcho(
    message({ meta: { sessionId: "sender", toSession: "recipient" } }),
    [registration(SOURCE, "recipient")],
    sessions([
      ["sender", "h<ia>"],
      ["recipient", "n`ia"],
    ]),
  );
  expect(formatted.sectionText).toContain("`h&lt;ia&gt; → nˋia`");
});

test("automation broadcasts and no-listener state remain explicit", () => {
  const formatted = formatSlackEcho(
    message({ from: "weft", project: TARGET, meta: undefined }),
    [registration(SOURCE, "sender")],
    new Map(),
  );
  expect(formatted.sectionText).toContain(
    "*weft* → *adaptive-escalation* `all`",
  );
  expect(formatted.listening).toBe(false);
});

test("native audit routes preserve the named native recipient", () => {
  const formatted = formatSlackEcho(
    message({
      delivery: "audit",
      meta: { sessionId: "sender", nativeRecipient: "reviewer" },
    }),
    [],
    sessions([["sender", "hia"]]),
  );
  expect(formatted.sectionText).toContain(
    "*llm-performance-models* · `hia → reviewer`",
  );
});

test("the complete Slack section stays within 3000 characters", () => {
  const formatted = formatSlackEcho(
    message({
      message: "x".repeat(5000),
      replyTo: "1234567890",
      meta: {
        sessionId: "sender",
        replyToFrom: "nia",
        replyToPreview: "context".repeat(1000),
      },
    }),
    [registration(SOURCE, "recipient")],
    sessions([
      ["sender", "hia"],
      ["recipient", "nia"],
    ]),
  );
  expect(formatted.sectionText.length).toBeLessThanOrEqual(3000);
  expect(formatted.sectionText.endsWith("…")).toBe(true);
});
