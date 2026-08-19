/** Config loading: ~/.config/agent-mail/config.toml (flat key = "value" TOML).
 *
 * Slack webhook resolution order:
 *   1. AGENT_MAIL_SLACK_WEBHOOK env var
 *   2. slack_webhook in config.toml
 */

import { existsSync, readFileSync } from "node:fs";
import { CONFIG_PATH, DEFAULT_PORT } from "./paths.ts";

export interface Config {
  port: number;
  slackWebhook: string | null;
  /** "all" echoes every message to Slack; "none" disables the echo. */
  slackEcho: "all" | "none";
  /** Bot token (xoxb-...) for the Web API; enables the editable Slack
   * dashboard (chat.update), which the incoming webhook can't do. */
  slackBotToken: string | null;
  /** Channel id the Slack dashboard posts/updates in (e.g. C0123ABCD). */
  slackChannel: string | null;
  /** Default per-session treatment of incoming agent-mail messages. */
  inboundPolicy: "accept" | "hold" | "refuse";
  /** Duplicate body suppression window. */
  duplicateWindowSeconds: number;
  /** Maximum accepted messages per sender in a rolling minute. */
  messageRateLimitPerMinute: number;
  /** Default expiry for messages without an explicit TTL; null means none. */
  defaultMessageTtlSeconds: number | null;
  /** Maximum held messages for one session before the oldest is refused. */
  heldMessageLimit: number;
  /** Whether the HTTP dashboard is served at all. Off by default: it renders
   * every project's sessions and message subjects, and the daemon's port is
   * reachable by any local process, so it is opened deliberately rather than
   * inherited by anyone who installs agent-mail. */
  dashboard: boolean;
}

/** Parse a flat TOML subset: `key = "string"` / `key = 123` lines, # comments. */
function parseFlatToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const m = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Short display aliases for project bases in session labels, so a long project
 * name reads compactly (e.g. `llm-performance-models` -> `augur`). Configured as
 * a comma list of `from=to` pairs in `session_aliases`, or the
 * `AGENT_MAIL_SESSION_ALIASES` env var. Keyed by the project directory basename. */
export function loadSessionAliases(): Map<string, string> {
  const raw = existsSync(CONFIG_PATH)
    ? parseFlatToml(readFileSync(CONFIG_PATH, "utf8"))
    : {};
  const spec =
    process.env.AGENT_MAIL_SESSION_ALIASES ?? raw.session_aliases ?? "";
  const map = new Map<string, string>();
  for (const pair of spec.split(",")) {
    const [from, to] = pair.split("=").map((s) => s.trim());
    if (from && to) map.set(from, to);
  }
  return map;
}

export function loadConfig(): Config {
  const raw = existsSync(CONFIG_PATH)
    ? parseFlatToml(readFileSync(CONFIG_PATH, "utf8"))
    : {};
  const port = Number(process.env.AGENT_MAIL_PORT ?? raw.port ?? DEFAULT_PORT);
  const slackWebhook =
    process.env.AGENT_MAIL_SLACK_WEBHOOK ?? raw.slack_webhook ?? null;
  const slackEcho = (raw.slack_echo ?? "all") === "none" ? "none" : "all";
  const slackBotToken =
    process.env.AGENT_MAIL_SLACK_BOT_TOKEN ?? raw.slack_bot_token ?? null;
  const slackChannel =
    process.env.AGENT_MAIL_SLACK_CHANNEL ?? raw.slack_channel ?? null;
  const policy =
    process.env.AGENT_MAIL_INBOUND_POLICY ?? raw.inbound_policy ?? "accept";
  const inboundPolicy =
    policy === "hold" || policy === "refuse" ? policy : "accept";
  const duplicateWindowSeconds = positiveNumber(
    process.env.AGENT_MAIL_DUPLICATE_WINDOW_SECONDS ??
      raw.duplicate_window_seconds,
    10,
  );
  const messageRateLimitPerMinute = positiveNumber(
    process.env.AGENT_MAIL_RATE_LIMIT_PER_MINUTE ??
      raw.message_rate_limit_per_minute,
    60,
  );
  const ttlSpec =
    process.env.AGENT_MAIL_DEFAULT_TTL_SECONDS ??
    raw.default_message_ttl_seconds;
  const defaultMessageTtlSeconds = ttlSpec
    ? positiveNumber(ttlSpec, 0) || null
    : null;
  const heldMessageLimit = positiveNumber(
    process.env.AGENT_MAIL_HELD_MESSAGE_LIMIT ?? raw.held_message_limit,
    100,
  );
  // Opt-in, and only to an explicit affirmative. Anything else — including a
  // misspelling — leaves it off, because the failure that matters is a
  // dashboard served by someone who did not mean to serve one.
  const dashboard = isTrue(process.env.AGENT_MAIL_DASHBOARD ?? raw.dashboard);
  return {
    port,
    slackWebhook,
    slackEcho,
    slackBotToken,
    slackChannel,
    inboundPolicy,
    duplicateWindowSeconds,
    messageRateLimitPerMinute,
    defaultMessageTtlSeconds,
    heldMessageLimit,
    dashboard,
  };
}

/** Affirmative config values, for flags that default to off. */
function isTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
