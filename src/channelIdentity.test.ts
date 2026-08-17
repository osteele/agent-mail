import { describe, expect, test } from "bun:test";
import {
  channelIdentity,
  describeChannelPush,
  diagnoseChannelPush,
  parseChannelsFlag,
  pushReceiptDetail,
} from "./channelIdentity.ts";

const PLUGIN_ROOT =
  "/Users/osteele/code/agent-tools/agent-mail/plugins/agent-mail";
const HOST_WITH_PLUGIN =
  "/Users/osteele/.local/bin/claude --channels=plugin:agent-mail@osteele-local --resume f588d728";

describe("parseChannelsFlag", () => {
  test("reads the specs off a launch command", () => {
    expect(parseChannelsFlag(HOST_WITH_PLUGIN)).toEqual([
      "plugin:agent-mail@osteele-local",
    ]);
  });

  test("accepts the development flag and multiple specs", () => {
    expect(
      parseChannelsFlag(
        "claude --dangerously-load-development-channels server:agent-mail,plugin:other@mkt",
      ),
    ).toEqual(["server:agent-mail", "plugin:other@mkt"]);
  });

  test("distinguishes a missing flag from one selecting nothing", () => {
    expect(parseChannelsFlag("claude --resume abc")).toBeUndefined();
    expect(parseChannelsFlag("claude --channels=")).toEqual([]);
  });
});

describe("channelIdentity", () => {
  test("a plugin-spawned server is identified by its plugin", () => {
    expect(channelIdentity("agent-mail", PLUGIN_ROOT)).toBe(
      "plugin:agent-mail",
    );
  });

  test("a config-spawned server is identified by its server name", () => {
    expect(channelIdentity("agent-mail")).toBe("server:agent-mail");
  });
});

describe("diagnoseChannelPush", () => {
  test("the plugin instance under a matching plugin spec is authorized", () => {
    const d = diagnoseChannelPush({
      hostCommand: HOST_WITH_PLUGIN,
      pluginRoot: PLUGIN_ROOT,
      serverName: "agent-mail",
    });
    expect(d.status).toBe("authorized");
    expect(pushReceiptDetail(d)).toBeUndefined();
    expect(describeChannelPush(d)).toBeUndefined();
  });

  // The regression this module exists for: a user-scope mcpServers entry won
  // the dedup against the plugin, so pushes came from an identity the host
  // never authorized and were dropped without any error.
  test("a shadowing user-scope instance is detected as unauthorized", () => {
    const d = diagnoseChannelPush({
      hostCommand: HOST_WITH_PLUGIN,
      pluginRoot: undefined,
      serverName: "agent-mail",
    });
    expect(d.status).toBe("identity-unauthorized");
    expect(d.identity).toBe("server:agent-mail");
    expect(pushReceiptDetail(d)).toBe("channel:identity-unauthorized");
    expect(describeChannelPush(d)).toContain("~/.claude.json");
  });

  test("an explicit server spec authorizes the user-scope instance", () => {
    const d = diagnoseChannelPush({
      hostCommand: "claude --channels=server:agent-mail",
      serverName: "agent-mail",
    });
    expect(d.status).toBe("authorized");
  });

  test("a plugin spec for a different plugin does not authorize us", () => {
    const d = diagnoseChannelPush({
      hostCommand: "claude --channels=plugin:something-else@osteele-local",
      pluginRoot: PLUGIN_ROOT,
      serverName: "agent-mail",
    });
    expect(d.status).toBe("identity-unauthorized");
  });

  test("a host with no channels flag reports host-not-loaded", () => {
    const d = diagnoseChannelPush({
      hostCommand: "claude --resume abc",
      pluginRoot: PLUGIN_ROOT,
      serverName: "agent-mail",
    });
    expect(d.status).toBe("host-not-loaded");
    expect(pushReceiptDetail(d)).toBe("channel:host-not-loaded");
  });

  test("an unreadable host command degrades to unknown, not to a verdict", () => {
    const d = diagnoseChannelPush({
      pluginRoot: PLUGIN_ROOT,
      serverName: "agent-mail",
    });
    expect(d.status).toBe("unknown");
    expect(pushReceiptDetail(d)).toBe("channel:unknown");
  });
});
