/** Editable Slack dashboard: one message, refreshed in place via chat.update.
 *
 * Needs a bot token + channel (config slack_bot_token / slack_channel) — the
 * incoming webhook used for per-message echoes can't edit messages. The
 * {channel, ts} of the live message is persisted so refreshes update it instead
 * of posting anew. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { type DashboardState, buildState } from "./dashboardData.ts";
import { SLACK_DASHBOARD_PATH, ensureDirs } from "./paths.ts";

interface DashboardRef {
  channel: string;
  ts: string;
}

function loadRef(): DashboardRef | null {
  if (!existsSync(SLACK_DASHBOARD_PATH)) return null;
  try {
    const doc = JSON.parse(readFileSync(SLACK_DASHBOARD_PATH, "utf8"));
    if (typeof doc.channel === "string" && typeof doc.ts === "string") {
      return { channel: doc.channel, ts: doc.ts };
    }
  } catch {
    // stale/corrupt ref; treat as no live message and repost
  }
  return null;
}

function saveRef(ref: DashboardRef): void {
  ensureDirs();
  writeFileSync(SLACK_DASHBOARD_PATH, `${JSON.stringify(ref, null, 1)}\n`);
}

function buildBlocks(state: DashboardState): object[] {
  const t = state.totals;
  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📬 agent-mail", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `*${t.messages}* messages · *${t.projects}* projects · ` +
            `*${t.threads}* threads · *${t.live}* live · updated ` +
            `<!date^${Math.floor(Date.parse(state.now) / 1000)}^{time}|now>`,
        },
      ],
    },
    { type: "divider" },
  ];

  const presence = state.presence.length
    ? state.presence
        .map(
          (p) =>
            `🟢 *${p.project}* — ${p.displayName}` +
            `${p.fullName === p.displayName ? "" : ` \`${p.fullName}\``}` +
            `${p.client ? ` \`${p.client}\`` : ""}` +
            `${p.capabilities.length ? ` \`${p.capabilities.join(",")}\`` : ""}` +
            `${p.activity ? ` _[${p.activity}]_` : ""}` +
            ` _[inbound:${p.inboundPolicy}]_` +
            `${p.muted ? " 🔕" : ""}`,
        )
        .join("\n")
    : "_no sessions listening_";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Live sessions*\n${presence}` },
  });

  const routes = state.routes.length
    ? state.routes
        .slice(0, 10)
        .map((r) => `${r.from} → ${r.to}  \`${r.count}\``)
        .join("\n")
    : "_no traffic yet_";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Traffic*\n${routes}` },
  });

  const log = state.log.length
    ? state.log
        .slice(0, 8)
        .map(
          (m) =>
            `\`${new Date(m.ts).toLocaleTimeString()}\` *${m.from}* → ${m.to}` +
            `${m.thread ? " ↩" : ""}: ${m.preview}`,
        )
        .join("\n")
    : "_inbox empty_";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Recent*\n${log}` },
  });

  return blocks;
}

async function slackApi(
  token: string,
  method: string,
  body: object,
): Promise<{ ok: boolean; error?: string; ts?: string }> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as { ok: boolean; error?: string; ts?: string };
}

export class SlackDashboardUnconfigured extends Error {}

/** Post the dashboard if absent, else edit the existing message in place.
 * Returns a one-line status. Throws SlackDashboardUnconfigured when the bot
 * token or channel is missing, and Error on a Slack API failure. */
export async function refreshSlackDashboard(config: Config): Promise<string> {
  const token = config.slackBotToken;
  const channel = config.slackChannel;
  if (!token || !channel) {
    throw new SlackDashboardUnconfigured(
      "slack dashboard needs slack_bot_token and slack_channel " +
        "(config.toml or AGENT_MAIL_SLACK_BOT_TOKEN / AGENT_MAIL_SLACK_CHANNEL)",
    );
  }

  const blocks = buildBlocks(buildState());
  const text = "agent-mail dashboard";
  const ref = loadRef();

  if (ref && ref.channel === channel) {
    const res = await slackApi(token, "chat.update", {
      channel,
      ts: ref.ts,
      text,
      blocks,
    });
    if (res.ok) return `updated dashboard (${channel} ${ref.ts})`;
    // The message was deleted out from under us; fall through to a fresh post.
    if (res.error !== "message_not_found") {
      throw new Error(`slack chat.update failed: ${res.error}`);
    }
  }

  const res = await slackApi(token, "chat.postMessage", {
    channel,
    text,
    blocks,
  });
  if (!res.ok || !res.ts) {
    throw new Error(`slack chat.postMessage failed: ${res.error}`);
  }
  saveRef({ channel, ts: res.ts });
  return `posted dashboard (${channel} ${res.ts})`;
}
