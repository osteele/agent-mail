import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.ts";
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
  ).toEqual({ status: "duplicate", id: "prior", reason: "idempotency-key" });
  // Same text, no key: caught by the signature window instead. The reason has
  // to distinguish the two — a sender that generated a one-off key reads a
  // key collision as its own message having already landed, and must not read
  // a signature collision the same way.
  expect(admissionDecision([prior], { ...base }, admission, now)).toEqual({
    status: "duplicate",
    id: "prior",
    reason: "signature",
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

test("findReceipts locates a sent message's receipts in the recipient's project", async () => {
  // The defect this guards: receipts are keyed to the recipient's project, so a
  // sender querying its own project always saw nothing, and an empty result
  // reads as "dropped". Three sessions acted on that in one day. STATE_DIR is
  // resolved at module load from HOME, so this runs in a subprocess.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-findreceipts-"));
  const receiptsDir = join(root, ".claude", "agent-mail", "receipts");
  const inboxDir = join(root, ".claude", "agent-mail", "inbox");
  mkdirSync(receiptsDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  const sender = "/projects/sender";
  const recipient = "/projects/recipient";
  // knownProjects() discovers projects from each spool's first line, and both
  // spool and receipt files are named by projectSlug — not by any name we pick.
  for (const project of [sender, recipient]) {
    writeFileSync(
      join(inboxDir, `${projectSlug(project)}.jsonl`),
      `${JSON.stringify({ id: `seed-${projectSlug(project)}`, ts: "2026-08-17T00:00:00.000Z", from: "x", project, message: "seed" })}\n`,
    );
  }
  writeFileSync(
    join(receiptsDir, `${projectSlug(recipient)}.jsonl`),
    `${JSON.stringify({ messageId: "m-1", project: recipient, ts: "2026-08-17T06:00:00.000Z", status: "spooled" })}\n${JSON.stringify({ messageId: "m-1", project: recipient, ts: "2026-08-17T06:00:01.000Z", status: "pushed", sessionId: "s-1" })}\n`,
  );

  const script = join(root, "probe.ts");
  writeFileSync(
    script,
    [
      `import { findReceipts, readReceipts } from ${JSON.stringify(join(import.meta.dir, "spool.ts"))};`,
      `const own = readReceipts(${JSON.stringify(sender)}, "m-1").length;`,
      `const found = findReceipts("m-1", ${JSON.stringify(sender)});`,
      `const missing = findReceipts("absent", ${JSON.stringify(sender)});`,
      "console.log(JSON.stringify({ own, project: found?.project ?? null, count: found?.receipts.length ?? 0, missing: missing === undefined }));",
    ].join("\n"),
  );
  try {
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const out = JSON.parse(await new Response(child.stdout).text()) as {
      own: number;
      project: string | null;
      count: number;
      missing: boolean;
    };
    expect(out.own).toBe(0); // the old, misleading answer
    expect(out.project).toBe(recipient); // found where they actually live
    expect(out.count).toBe(2);
    expect(out.missing).toBe(true); // a genuinely unknown id still reports nothing
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
