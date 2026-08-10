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
import { LOG_PATH, PID_PATH, canonicalProject, ensureDirs } from "./paths.ts";
import { listLive } from "./registry.ts";
import { claudeSessions, resetSessionAliasCache } from "./sessions.ts";
import { formatSlackEcho } from "./slackEcho.ts";
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

async function echoToSlack(msg: Message): Promise<void> {
  if (
    config.slackEcho === "none" ||
    !config.slackWebhook ||
    !shouldEchoMessageToSlack(msg)
  )
    return;
  const formatted = formatSlackEcho(msg, listLive(), claudeSessions());
  const blocks: object[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: formatted.sectionText },
    },
  ];
  if (!formatted.listening) {
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
      text: formatted.fallbackText,
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
