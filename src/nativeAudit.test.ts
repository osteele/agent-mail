import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAuditFields, nativeAuditMessage } from "./nativeAudit.ts";

test("native SendMessage hook input becomes a non-deliverable audit message", () => {
  // The point is that the hook's cwd is canonicalized. This used to ride on
  // macOS resolving /tmp to /private/tmp, which made the assertion a statement
  // about the platform rather than about the code. On Linux /tmp is already
  // canonical, so the expectation could not hold. Build the symlink instead so
  // the same claim is tested everywhere.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-audit-")));
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);

  const fields = nativeAuditFields({
    hook_event_name: "PostToolUse",
    tool_name: "SendMessage",
    tool_input: { to: "payments-3f", message: "Migration is complete" },
    cwd: link,
    session_id: "sender-session",
    tool_use_id: "tool-123",
  });
  expect(fields).not.toBeNull();
  if (!fields) throw new Error("expected parsed SendMessage fields");
  const message = nativeAuditMessage(
    fields,
    Date.parse("2026-08-09T12:00:00.000Z"),
  );
  expect(message).toMatchObject({
    project: real,
    delivery: "audit",
    message: "Migration is complete",
    idempotencyKey: "tool-123",
    origin: {
      kind: "agent",
      transport: "native-audit",
      client: "claude-code",
      sessionId: "sender-session",
      authority: "untrusted",
    },
    meta: { nativeRecipient: "payments-3f" },
  });

  rmSync(root, { recursive: true, force: true });
});

test("audit parser ignores unrelated and incomplete tool calls", () => {
  expect(
    nativeAuditFields({ tool_name: "Bash", tool_input: {}, cwd: "/tmp" }),
  ).toBeNull();
  expect(
    nativeAuditFields({
      tool_name: "SendMessage",
      tool_input: { to: "peer" },
      cwd: "/tmp",
    }),
  ).toBeNull();
});
