/** Whether this server's channel pushes can be authorized by the host.
 *
 * Claude Code authorizes channel events by the *identity* of the MCP server
 * that emits them, and `mcp.notification()` is fire-and-forget over stdio with
 * no ack — so an unauthorized identity has its events accepted and silently
 * discarded, and the receipt still says "pushed". That failure mode ran for
 * days: agent-mail was registered both as a user-scope `mcpServers` entry and
 * by the plugin under the same server name, Claude deduped to the user-scope
 * one, and its `server:agent-mail` identity was not in the host's allowlist.
 *
 * The distinguishing signal is cheap and local: the plugin instance is spawned
 * with CLAUDE_PLUGIN_ROOT in its environment and the user-scope instance is
 * not. Comparing that against the channel specs the host was launched with
 * tells us, at startup, whether our pushes can land. */

import { basename } from "node:path";

export type ChannelPushStatus =
  | "authorized"
  | "host-not-loaded"
  | "identity-unauthorized"
  | "unknown";

export interface ChannelPushDiagnosis {
  status: ChannelPushStatus;
  /** This server's channel identity, e.g. `plugin:agent-mail`. */
  identity: string;
  /** Channel specs the host was launched with; absent when unreadable. */
  hostChannels?: string[];
}

/** Channel specs the host was launched with, or undefined when it carries no
 * channels flag at all. Both the stable and the development flag are accepted;
 * a flag with an empty value counts as present but selecting nothing. */
export function parseChannelsFlag(command: string): string[] | undefined {
  const match =
    /--channels[= ]([^\s]*)/.exec(command) ??
    /--dangerously-load-development-channels[= ]([^\s]*)/.exec(command);
  if (!match) return undefined;
  return match[1]
    .split(",")
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0);
}

/** Our identity as the host names it. A plugin-spawned server is identified by
 * its plugin, a config-spawned one by its server name. */
export function channelIdentity(
  serverName: string,
  pluginRoot?: string,
): string {
  return pluginRoot ? `plugin:${basename(pluginRoot)}` : `server:${serverName}`;
}

/** A spec authorizes an identity when they name the same thing. Plugin specs
 * carry a marketplace suffix (`plugin:agent-mail@osteele-local`) that the
 * identity cannot know, so it is compared on the plugin name alone. */
function authorizes(spec: string, identity: string): boolean {
  const [scope, rest] = spec.split(":", 2);
  if (!rest) return false;
  const name = scope === "plugin" ? rest.split("@", 1)[0] : rest;
  return `${scope}:${name}` === identity;
}

export function diagnoseChannelPush(input: {
  hostCommand?: string;
  pluginRoot?: string;
  serverName: string;
}): ChannelPushDiagnosis {
  const identity = channelIdentity(input.serverName, input.pluginRoot);
  if (input.hostCommand === undefined) return { status: "unknown", identity };
  const hostChannels = parseChannelsFlag(input.hostCommand);
  if (hostChannels === undefined) {
    return { status: "host-not-loaded", identity };
  }
  const status = hostChannels.some((spec) => authorizes(spec, identity))
    ? "authorized"
    : "identity-unauthorized";
  return { status, identity, hostChannels };
}

/** Receipt detail for a push emitted under this diagnosis, or undefined when
 * the push is expected to land. A `pushed` receipt carrying one of these is
 * evidence the event was emitted and *not* that anything received it. */
export function pushReceiptDetail(
  diagnosis: ChannelPushDiagnosis,
): string | undefined {
  if (diagnosis.status === "authorized") return undefined;
  return `channel:${diagnosis.status}`;
}

/** One-line operator explanation, for the MCP server log at startup. */
export function describeChannelPush(
  diagnosis: ChannelPushDiagnosis,
): string | undefined {
  const loaded = diagnosis.hostChannels?.join(", ") || "(none)";
  switch (diagnosis.status) {
    case "authorized":
      return undefined;
    case "host-not-loaded":
      return `channel push inert: host was launched without a channels flag, so pushes from ${diagnosis.identity} are not delivered. Mail still spools and is readable via check_inbox.`;
    case "identity-unauthorized":
      return `channel push will be DROPPED: this server's identity is ${diagnosis.identity}, but the host authorized ${loaded}. A user-scope mcpServers entry with the same server name shadows the plugin — remove it from ~/.claude.json and restart the session.`;
    case "unknown":
      return `channel push authorization unverified: could not read the host process command line. Identity is ${diagnosis.identity}.`;
  }
}
