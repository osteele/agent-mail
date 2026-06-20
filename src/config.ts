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
  return { port, slackWebhook, slackEcho, slackBotToken, slackChannel };
}
