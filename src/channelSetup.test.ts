import { describe, expect, test } from "bun:test";
import {
  allowedChannelPluginIds,
  channelsEnabledIn,
  describeChannelSetup,
  findChannelPlugin,
} from "./channelSetup.ts";

const SERVER = "/checkout/src/channel.ts";

function pluginList(entries: unknown[]): string {
  return JSON.stringify(entries);
}

const servingEntry = {
  id: "agent-mail@osteele-local",
  version: "0.1.0",
  enabled: true,
  mcpServers: { "agent-mail": { command: "bun", args: [SERVER] } },
};

describe("findChannelPlugin", () => {
  test("matches the plugin whose server args include this checkout's path", () => {
    expect(findChannelPlugin(pluginList([servingEntry]), SERVER)).toEqual({
      id: "agent-mail@osteele-local",
      version: "0.1.0",
      enabled: true,
    });
  });

  test("ignores plugins serving other paths or no MCP servers", () => {
    const others = [
      { id: "github@official" },
      {
        id: "other@market",
        mcpServers: { srv: { args: ["/elsewhere/channel.ts"] } },
      },
    ];
    expect(findChannelPlugin(pluginList(others), SERVER)).toBeNull();
  });

  test("a served path in a different checkout does not match", () => {
    expect(
      findChannelPlugin(pluginList([servingEntry]), "/other/src/channel.ts"),
    ).toBeNull();
  });

  test("enabled defaults to true and false is preserved", () => {
    const disabled = { ...servingEntry, enabled: false };
    expect(findChannelPlugin(pluginList([disabled]), SERVER)?.enabled).toBe(
      false,
    );
    const { enabled: _omitted, ...noEnabled } = servingEntry;
    expect(findChannelPlugin(pluginList([noEnabled]), SERVER)?.enabled).toBe(
      true,
    );
  });

  test("version is omitted when the entry carries none", () => {
    const { version: _omitted, ...noVersion } = servingEntry;
    const found = findChannelPlugin(pluginList([noVersion]), SERVER);
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty("version");
  });

  test("non-array JSON and entries without string ids yield null", () => {
    expect(findChannelPlugin("{}", SERVER)).toBeNull();
    expect(
      findChannelPlugin(
        pluginList([{ mcpServers: servingEntry.mcpServers }]),
        SERVER,
      ),
    ).toBeNull();
  });
});

describe("allowedChannelPluginIds", () => {
  test("renders {marketplace, plugin} entries back to plugin@marketplace ids", () => {
    expect(
      allowedChannelPluginIds({
        allowedChannelPlugins: [
          { marketplace: "osteele-local", plugin: "agent-mail" },
          "bare-id@somewhere",
          { plugin: "no-marketplace" },
        ],
      }),
    ).toEqual([
      "agent-mail@osteele-local",
      "bare-id@somewhere",
      "no-marketplace",
    ]);
  });

  test("malformed settings and entries yield no ids", () => {
    expect(allowedChannelPluginIds(undefined)).toEqual([]);
    expect(allowedChannelPluginIds({ allowedChannelPlugins: "nope" })).toEqual(
      [],
    );
    expect(
      allowedChannelPluginIds({
        allowedChannelPlugins: [42, null, { marketplace: "m" }],
      }),
    ).toEqual([]);
  });
});

describe("channelsEnabledIn", () => {
  test("reads only an explicit boolean", () => {
    expect(channelsEnabledIn({ channelsEnabled: true })).toBe(true);
    expect(channelsEnabledIn({ channelsEnabled: false })).toBe(false);
  });

  test("absent or non-boolean values are unknown, never disabled", () => {
    expect(channelsEnabledIn({})).toBeUndefined();
    expect(channelsEnabledIn({ channelsEnabled: "yes" })).toBeUndefined();
    expect(channelsEnabledIn(undefined)).toBeUndefined();
  });
});

describe("describeChannelSetup", () => {
  const installed = {
    id: "agent-mail@osteele-local",
    version: "0.1.0",
    enabled: true,
  };

  test("everything in place reports state, not instructions", () => {
    const lines = describeChannelSetup({
      plugin: installed,
      channelsEnabled: true,
      pluginAllowed: true,
    }).join("\n");
    expect(lines).toContain("agent-mail@osteele-local 0.1.0 enabled");
    expect(lines).toContain("channels: enabled in managed settings");
    expect(lines).toContain("allowed:  yes");
    expect(lines).toContain("--channels=plugin:agent-mail@osteele-local");
    expect(lines).not.toContain("marketplace add");
  });

  test("unknown states say the source was unreadable, not that setup is absent", () => {
    const lines = describeChannelSetup({
      plugin: undefined,
      channelsEnabled: undefined,
      pluginAllowed: undefined,
    }).join("\n");
    expect(lines).toContain("unknown — could not run `claude plugin list`");
    expect(lines).toContain("unknown — no readable managed settings");
    expect(lines).not.toContain("not installed");
    expect(lines).not.toContain("disabled");
  });

  test("not installed prints install steps, with the repo root when known", () => {
    const facts = {
      plugin: null,
      channelsEnabled: true,
      pluginAllowed: undefined,
    };
    expect(describeChannelSetup(facts, "/checkout").join("\n")).toContain(
      "claude plugin marketplace add /checkout",
    );
    expect(describeChannelSetup(facts).join("\n")).toContain(
      "claude plugin marketplace add <this repo>",
    );
  });

  test("installed-but-disabled and disallowed name the unmet step", () => {
    const lines = describeChannelSetup({
      plugin: { ...installed, enabled: false },
      channelsEnabled: false,
      pluginAllowed: false,
    }).join("\n");
    expect(lines).toContain("installed but disabled");
    expect(lines).toContain("channels: disabled in managed settings");
    expect(lines).toContain(
      "add agent-mail@osteele-local to allowedChannelPlugins",
    );
  });
});
