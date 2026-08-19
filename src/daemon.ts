#!/usr/bin/env bun
/** agent-mail daemon: localhost HTTP ingress + Slack echo.
 *
 * Endpoints (127.0.0.1 only):
 *   POST /notify   {project, from, message, meta?} -> append spool, echo Slack
 *   POST /read     {project, ids?} or {project, all:true} -> mark read
 *   GET  /health   daemon liveness + config summary
 *   GET  /          persistent read-only dashboard
 *   GET  /api/state dashboard JSON
 *   GET  /registry live channel-server registrations
 *   GET  /inbox?project=<path>&limit=N&unread=1  read a project's spool
 *
 * SIGTERM: graceful stop. SIGHUP: reload config (Slack webhook, echo mode).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { type Config, loadConfig } from "./config.ts";
import { dashboardResponse } from "./dashboard.ts";
import { LOG_PATH, PID_PATH, canonicalProject, ensureDirs } from "./paths.ts";
import { writePresenceSnapshot } from "./presence.ts";
import { writeProcessSnapshot } from "./processSnapshot.ts";
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
import { flushTransferNotifications, transfers } from "./transfers.ts";
import {
  WEFT_JOBS_REFRESH_MS,
  countBySession,
  writeWeftJobsSnapshot,
} from "./weftJobs.ts";

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

    if (req.method === "GET") {
      const dashboard = dashboardResponse(req);
      if (dashboard) return dashboard;
    }

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
        // Stored verbatim: the sender matches against it if it has to fall back
        // to a direct append after losing this response.
        ...(body.attemptKey ? { attemptKey: body.attemptKey } : {}),
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

/** Periodic liveness sweep.
 *
 * Two jobs. It publishes the snapshot that latency-bound readers (the status
 * line) use instead of running their own process scan. And because `listLive()`
 * prunes as a side effect, this is the only thing that removes dead
 * registrations without a human happening to run `listeners` or open a
 * dashboard.
 *
 * No SIGHUP coupling is needed because the snapshot stores raw registrations —
 * nothing in it derives from config. If it ever starts carrying names or
 * aliases, it must be invalidated in the SIGHUP handler too. */
const PRESENCE_TICK_MS = 10_000;
let lastLiveCount = -1;

function tickPresence(): void {
  try {
    const snapshot = writePresenceSnapshot();
    writeProcessSnapshot();
    flushTransferNotifications();
    for (const request of transfers.settleExpired()) {
      log(`coordination transfer ${request.id}: ${request.status}`);
    }
    flushTransferNotifications();
    // Log only on change: this fires every 10s and daemon.log is long-lived.
    if (snapshot.sessions.length !== lastLiveCount) {
      lastLiveCount = snapshot.sessions.length;
      log(`presence snapshot: ${lastLiveCount} live`);
    }
  } catch (error) {
    // An interval callback that throws takes the daemon down with it.
    log(`presence snapshot failed: ${error}`);
  }
}

/** Refresh the weft unprocessed-jobs snapshot.
 *
 * Deliberately on its own slow timer rather than the 10s presence tick: the
 * query starts a Go binary and takes seconds, so running it every tick would
 * occupy a core continuously. `refreshing` skips a cycle whose predecessor is
 * still running, which matters most exactly when the machine is loaded enough
 * for the query to outlast the interval.
 *
 * A failure logs and leaves the previous snapshot in place. Readers judge it
 * by its own `generatedAt`, so an unrefreshed file ages out of validity on its
 * own rather than needing to be deleted. */
let refreshing = false;

function tickWeftJobs(): void {
  if (refreshing) return;
  refreshing = true;
  const proc = Bun.spawn(
    ["weft", "list", "jobs", "--unprocessed", "--format", "json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  Bun.readableStreamToText(proc.stdout)
    .then(async (out) => {
      const code = await proc.exited;
      if (code !== 0) throw new Error(`weft exited ${code}`);
      const counts = countBySession(JSON.parse(out));
      writeWeftJobsSnapshot(counts);
      if (counts.total !== lastWeftTotal) {
        lastWeftTotal = counts.total;
        log(`weft jobs snapshot: ${counts.total} unprocessed`);
      }
    })
    .catch((error) => {
      // weft absent, slow, or unparseable output. The stale snapshot stands
      // and expires on its own.
      log(`weft jobs snapshot failed: ${error}`);
    })
    .finally(() => {
      refreshing = false;
    });
}

let lastWeftTotal = -1;

// Publish once synchronously so the first readers aren't left without a
// snapshot for a whole tick.
tickPresence();
const presenceTimer = setInterval(tickPresence, PRESENCE_TICK_MS);
tickWeftJobs();
const weftJobsTimer = setInterval(tickWeftJobs, WEFT_JOBS_REFRESH_MS);

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
    clearInterval(presenceTimer);
    clearInterval(weftJobsTimer);
    server.stop();
    process.exit(0);
  });
}
