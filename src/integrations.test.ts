import { expect, test } from "bun:test";
import {
  addNativeAuditHook,
  claudeRegistrationMatches,
  codexRegistrationMatches,
  enabledAgentMailPlugin,
  removeNativeAuditHook,
} from "./integrations.ts";

const bun = "/opt/bun/bin/bun";
const audit = "/code/agent-mail/src/nativeAudit.ts";

test("native audit hook installation is additive and idempotent", () => {
  const initial = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: "lint" }],
        },
      ],
    },
  };
  const first = addNativeAuditHook(initial, bun, audit);
  expect(first.changed).toBe(true);
  expect(
    (first.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toHaveLength(2);
  const second = addNativeAuditHook(first.document, bun, audit);
  expect(second.changed).toBe(false);
  expect(
    (second.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toHaveLength(2);
});

test("native audit hook removal preserves unrelated handlers", () => {
  const installed = addNativeAuditHook({}, bun, audit).document;
  const hooks = installed.hooks as { PostToolUse: unknown[] };
  hooks.PostToolUse.push({
    matcher: "SendMessage",
    hooks: [{ type: "command", command: "other-audit" }],
  });
  const result = removeNativeAuditHook(installed, audit);
  expect(result.changed).toBe(true);
  expect(
    (result.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toEqual([
    {
      matcher: "SendMessage",
      hooks: [{ type: "command", command: "other-audit" }],
    },
  ]);
});

test("Codex registration matching requires the exact stdio command", () => {
  const registration = {
    transport: { type: "stdio", command: bun, args: ["/code/channel.ts"] },
  };
  expect(codexRegistrationMatches(registration, bun, "/code/channel.ts")).toBe(
    true,
  );
  expect(codexRegistrationMatches(registration, bun, "/other/channel.ts")).toBe(
    false,
  );
});

test("Claude registration matching requires the exact stdio command", () => {
  const registration = {
    type: "stdio",
    command: bun,
    args: ["/code/channel.ts"],
    env: {},
  };
  expect(claudeRegistrationMatches(registration, bun, "/code/channel.ts")).toBe(
    true,
  );
  expect(
    claudeRegistrationMatches(registration, bun, "/other/channel.ts"),
  ).toBe(false);
});

test("an enabled agent-mail plugin is found under any marketplace", () => {
  expect(
    enabledAgentMailPlugin({
      enabledPlugins: { "other@mkt": true, "agent-mail@osteele-local": true },
    }),
  ).toBe("agent-mail@osteele-local");
});

test("a disabled or absent agent-mail plugin does not count", () => {
  expect(
    enabledAgentMailPlugin({ enabledPlugins: { "agent-mail@mkt": false } }),
  ).toBeUndefined();
  expect(enabledAgentMailPlugin({ enabledPlugins: {} })).toBeUndefined();
  expect(enabledAgentMailPlugin({})).toBeUndefined();
  expect(enabledAgentMailPlugin(undefined)).toBeUndefined();
});

test("a plugin whose name merely starts with agent-mail does not count", () => {
  expect(
    enabledAgentMailPlugin({ enabledPlugins: { "agent-mailer@mkt": true } }),
  ).toBeUndefined();
});
