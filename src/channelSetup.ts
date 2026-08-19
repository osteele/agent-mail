/** Observed state of the Claude Code channel opt-in.
 *
 * Channel push needs several independent things to line up, none of which
 * agent-mail controls: a plugin installed from a marketplace, channels enabled
 * and this plugin allowed in managed settings, and each session launched with
 * the channel. Printing the instructions instead of the state is what let a
 * stale flag string survive seven weeks in four places, so every user-facing
 * surface reports what it can see and says so when it cannot see.
 *
 * Plugin state comes from `claude plugin list --json`, a public machine surface,
 * never from Claude Code's own config files.
 */

import { readFileSync } from "node:fs";

export const MANAGED_SETTINGS_PATH =
  "/Library/Application Support/ClaudeCode/managed-settings.json";

/** A plugin providing this repo's channel server, if one is installed. */
export interface InstalledChannelPlugin {
  id: string;
  version?: string;
  enabled: boolean;
}

export interface ChannelSetupFacts {
  /** `undefined` means the query failed: unknown, not absent. */
  plugin: InstalledChannelPlugin | null | undefined;
  channelsEnabled: boolean | undefined;
  /** Whether the installed plugin's id appears in `allowedChannelPlugins`. */
  pluginAllowed: boolean | undefined;
}

interface PluginListEntry {
  id?: unknown;
  version?: unknown;
  enabled?: unknown;
  mcpServers?: unknown;
}

/** True when this entry serves the channel server at `serverPath`. */
function servesChannel(entry: PluginListEntry, serverPath: string): boolean {
  const servers = entry.mcpServers;
  if (typeof servers !== "object" || servers === null) return false;
  for (const server of Object.values(servers as Record<string, unknown>)) {
    if (typeof server !== "object" || server === null) continue;
    const args = (server as { args?: unknown }).args;
    if (!Array.isArray(args)) continue;
    if (args.some((arg) => arg === serverPath)) return true;
  }
  return false;
}

export function findChannelPlugin(
  listJson: string,
  serverPath: string,
): InstalledChannelPlugin | null {
  const parsed: unknown = JSON.parse(listJson);
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed as PluginListEntry[]) {
    if (typeof raw.id !== "string") continue;
    if (!servesChannel(raw, serverPath)) continue;
    return {
      id: raw.id,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      enabled: raw.enabled !== false,
    };
  }
  return null;
}

interface ManagedSettings {
  channelsEnabled?: unknown;
  allowedChannelPlugins?: unknown;
}

/** `{marketplace, plugin}` entries rendered back to `plugin@marketplace` ids. */
export function allowedChannelPluginIds(settings: unknown): string[] {
  if (typeof settings !== "object" || settings === null) return [];
  const allowed = (settings as ManagedSettings).allowedChannelPlugins;
  if (!Array.isArray(allowed)) return [];
  const ids: string[] = [];
  for (const entry of allowed) {
    if (typeof entry === "string") {
      ids.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { marketplace, plugin } = entry as {
      marketplace?: unknown;
      plugin?: unknown;
    };
    if (typeof plugin !== "string") continue;
    ids.push(
      typeof marketplace === "string" ? `${plugin}@${marketplace}` : plugin,
    );
  }
  return ids;
}

export function channelsEnabledIn(settings: unknown): boolean | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const value = (settings as ManagedSettings).channelsEnabled;
  return typeof value === "boolean" ? value : undefined;
}

/** Query the two external sources. Unreachable sources read as unknown. */
export function inspectChannelSetup(serverPath: string): ChannelSetupFacts {
  let plugin: InstalledChannelPlugin | null | undefined;
  try {
    const listed = Bun.spawnSync(["claude", "plugin", "list", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (listed.exitCode === 0) {
      plugin = findChannelPlugin(listed.stdout.toString(), serverPath);
    }
  } catch {
    // Bun.spawnSync throws when `claude` is not on PATH. No CLI means the
    // plugin state cannot be observed at all: unknown, not absent.
  }

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(MANAGED_SETTINGS_PATH, "utf8"));
  } catch {
    // Absent or unreadable managed settings: unknown, not disabled. A wrong
    // "disabled" would send a reader to change a file that may not be theirs.
    settings = undefined;
  }
  const allowed = allowedChannelPluginIds(settings);
  return {
    plugin,
    channelsEnabled: channelsEnabledIn(settings),
    pluginAllowed:
      settings === undefined || plugin === undefined || plugin === null
        ? undefined
        : allowed.includes(plugin.id),
  };
}

/** Human report: what is in place, and the next unmet step if any.
 *
 * `repoRoot`, when known, makes the not-installed instruction pasteable —
 * the marketplace lives at this repo's root. */
export function describeChannelSetup(
  facts: ChannelSetupFacts,
  repoRoot?: string,
): string[] {
  const lines: string[] = ["Channel push (Claude Code):"];

  if (facts.plugin === undefined) {
    lines.push("  plugin:   unknown — could not run `claude plugin list`");
  } else if (facts.plugin === null) {
    lines.push("  plugin:   not installed — no plugin serves this channel");
    lines.push(
      `            claude plugin marketplace add ${repoRoot ?? "<this repo>"}`,
    );
    lines.push("            claude plugin install agent-mail@osteele-local");
  } else if (!facts.plugin.enabled) {
    lines.push(`  plugin:   ${facts.plugin.id} installed but disabled`);
  } else {
    const version = facts.plugin.version ? ` ${facts.plugin.version}` : "";
    lines.push(`  plugin:   ${facts.plugin.id}${version} enabled`);
  }

  if (facts.channelsEnabled === undefined) {
    lines.push("  channels: unknown — no readable managed settings");
  } else {
    lines.push(
      `  channels: ${facts.channelsEnabled ? "enabled" : "disabled"} in managed settings`,
    );
  }

  if (facts.pluginAllowed === false && facts.plugin) {
    lines.push(
      `  allowed:  no — add ${facts.plugin.id} to allowedChannelPlugins`,
    );
  } else if (facts.pluginAllowed === true) {
    lines.push("  allowed:  yes");
  }

  lines.push(
    "  per session: each host must be launched with",
    facts.plugin
      ? `    claude --channels=plugin:${facts.plugin.id}`
      : "    claude --channels=plugin:<plugin>@<marketplace>",
    "  `agent-mail listeners` tags one that was not {channel:host-not-loaded},",
    "  from its next launch on.",
  );
  return lines;
}
