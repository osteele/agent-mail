#!/usr/bin/env bun
/** agent-mail daemon: localhost HTTP ingress + Slack echo.
 *
 * Endpoints (127.0.0.1 only):
 *   POST /notify   {project, from, message, meta?} -> append spool, echo Slack
 *   POST /read     {project, ids?} or {project, all:true} -> mark read
 *   GET  /health   daemon liveness + config summary
 *   GET  /registry live channel-server registrations
 *   GET  /inbox?project=<path>&limit=N&unread=1  read a project's spool
 *
 * SIGTERM: graceful stop. SIGHUP: reload config (Slack webhook, echo mode).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { type Config, loadConfig } from "./config.ts";
import {
  LOG_PATH,
  PID_PATH,
  canonicalProject,
  displayName,
  ensureDirs,
} from "./paths.ts";
import { listLive } from "./registry.ts";
import {
  claudeSessions,
  resetSessionAliasCache,
  sessionDisplayName,
} from "./sessions.ts";
import {
  type AdmissionOptions,
  type Message,
  appendMessageGuarded,
  markAllMessagesRead,
  markMessagesRead,
  readMessages,
  readReceipts,
  shouldEchoMessageToSlack,
} from "./spool.ts";

let config: Config = loadConfig();

function admissionOptions(): AdmissionOptions {
  return {
    duplicateWindowSeconds: config.duplicateWindowSeconds,
    messageRateLimitPerMinute: config.messageRateLimitPerMinute,
    defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
  };
}

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  appendFileSync(LOG_PATH, stamped);
}

/** Slack section text caps at 3000 chars; leave headroom for mrkdwn escaping. */
const SLACK_BODY_LIMIT = 2900;

function slackDate(ts: string): string {
  const epoch = Math.floor(Date.parse(ts) / 1000);
  if (!Number.isFinite(epoch)) return "";
  const fallback = new Date(ts).toLocaleTimeString();
  return ` · <!date^${epoch}^{time}|${fallback}>`;
}

async function echoToSlack(msg: Message): Promise<void> {
  if (
    config.slackEcho === "none" ||
    !config.slackWebhook ||
    !shouldEchoMessageToSlack(msg)
  )
    return;
  // A message from a session shows its humanized session label (which already
  // carries the project base); one from the CLI/weft shows its `from` label.
  const senderSid = msg.meta?.sessionId;
  const sender = senderSid
    ? sessionDisplayName(senderSid, claudeSessions().get(senderSid), msg.from)
    : displayName(msg.from);
  const recipient =
    msg.delivery === "audit" && msg.meta?.nativeRecipient
      ? msg.meta.nativeRecipient
      : displayName(msg.project);
  const listening = listLive().some(
    (r) => canonicalProject(r.cwd) === msg.project,
  );
  const body =
    msg.message.length > SLACK_BODY_LIMIT
      ? `${msg.message.slice(0, SLACK_BODY_LIMIT - 1)}…`
      : msg.message;

  const lines = [`:mailbox: *${sender}* → *${recipient}*${slackDate(msg.ts)}`];
  // Incoming webhooks can't post into a Slack thread (that needs a bot token —
  // see ROADMAP), so a reply renders its parent inline as quoted context.
  if (msg.replyTo) {
    const re = msg.meta?.replyToFrom
      ? `*${msg.meta.replyToFrom}*: ${msg.meta.replyToPreview ?? ""}`
      : `message ${msg.replyTo.slice(0, 8)}`;
    lines.push(`↩︎ re ${re}`);
  }
  lines.push(body);
  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  if (!listening) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_no session listening; spooled_" }],
    });
  }

  const resp = await fetch(config.slackWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `text` is the notification/preview fallback when blocks can't render.
    body: JSON.stringify({
      text: `📬 ${sender} → ${recipient}: ${body}`,
      blocks,
    }),
  });
  if (!resp.ok) {
    log(`slack echo failed: ${resp.status} ${await resp.text()}`);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

ensureDirs();
writeFileSync(PID_PATH, String(process.pid));

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        pid: process.pid,
        port: config.port,
        slack: config.slackWebhook ? config.slackEcho : "unconfigured",
      });
    }

    if (req.method === "GET" && url.pathname === "/registry") {
      return json(listLive());
    }

    if (req.method === "GET" && url.pathname === "/inbox") {
      const project = url.searchParams.get("project");
      if (!project) return json({ error: "missing ?project=" }, 400);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const unread = url.searchParams.get("unread") === "1";
      return json(
        readMessages(canonicalProject(project), { limit, unreadOnly: unread }),
      );
    }

    if (req.method === "GET" && url.pathname === "/receipts") {
      const project = url.searchParams.get("project");
      if (!project) return json({ error: "missing ?project=" }, 400);
      const messageId = url.searchParams.get("message") ?? undefined;
      return json(readReceipts(canonicalProject(project), messageId));
    }

    if (req.method === "POST" && url.pathname === "/notify") {
      let body: Partial<Message> & { ttlSeconds?: unknown };
      try {
        body = (await req.json()) as Partial<Message>;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!body.project || !body.message) {
        return json({ error: "required fields: project, message" }, 400);
      }
      if (Buffer.byteLength(body.message, "utf8") > 65_536) {
        return json({ error: "message exceeds 64 KiB" }, 413);
      }
      const now = Date.now();
      const ttlSeconds =
        typeof body.ttlSeconds === "number" && body.ttlSeconds >= 0
          ? body.ttlSeconds
          : undefined;
      const msg: Message = {
        ts: new Date(now).toISOString(),
        from: body.from ?? "unknown",
        project: canonicalProject(body.project),
        message: body.message,
        delivery: body.delivery === "audit" ? "audit" : "mail",
        origin: {
          kind: body.origin?.kind ?? "automation",
          transport: body.origin?.transport ?? "http",
          ...(body.origin?.client ? { client: body.origin.client } : {}),
          ...(body.origin?.sessionId
            ? { sessionId: body.origin.sessionId }
            : {}),
          // Local callers may describe provenance, but cannot grant authority.
          authority: "untrusted",
        },
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        ...(ttlSeconds !== undefined
          ? { expiresAt: new Date(now + ttlSeconds * 1000).toISOString() }
          : body.expiresAt
            ? { expiresAt: body.expiresAt }
            : {}),
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.threadId ? { threadId: body.threadId } : {}),
        ...(body.slackEcho === false ? { slackEcho: false } : {}),
        ...(body.meta ? { meta: body.meta } : {}),
      };
      const result = appendMessageGuarded(msg, admissionOptions(), now);
      if (result.status === "rate_limited") {
        return json(result, 429);
      }
      if (result.status === "duplicate") return json(result);
      log(`notify from=${msg.from} project=${msg.project}`);
      // Fire-and-forget: the spool append is the durable commitment; a slow
      // Slack POST must not delay the response (a timed-out client would
      // fall back to a direct spool append and double-deliver).
      echoToSlack(msg).catch((err) => log(`slack echo error: ${err}`));
      return json({ ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/read") {
      let body: { project?: string; ids?: unknown; all?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!body.project) return json({ error: "required field: project" }, 400);
      const project = canonicalProject(body.project);
      if (body.all === true) {
        return json({ ok: true, marked: markAllMessagesRead(project) });
      }
      if (!Array.isArray(body.ids)) {
        return json({ error: "required field: ids array or all=true" }, 400);
      }
      const ids = body.ids.filter((id): id is string => typeof id === "string");
      return json({ ok: true, marked: markMessagesRead(project, ids) });
    }

    return json({ error: "not found" }, 404);
  },
});

log(`daemon started pid=${process.pid} port=${config.port}`);

process.on("SIGHUP", () => {
  config = loadConfig();
  resetSessionAliasCache();
  log(
    `config reloaded (slack: ${config.slackWebhook ? config.slackEcho : "unconfigured"})`,
  );
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig} received, stopping`);
    server.stop();
    process.exit(0);
  });
}
