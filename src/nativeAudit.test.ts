import { expect, test } from "bun:test";
import { nativeAuditFields, nativeAuditMessage } from "./nativeAudit.ts";

test("native SendMessage hook input becomes a non-deliverable audit message", () => {
  const fields = nativeAuditFields({
    hook_event_name: "PostToolUse",
    tool_name: "SendMessage",
    tool_input: { to: "payments-3f", message: "Migration is complete" },
    cwd: "/tmp",
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
    project: "/private/tmp",
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
