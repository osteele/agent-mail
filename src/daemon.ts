#!/usr/bin/env bun
/** agent-mail daemon: localhost HTTP ingress + Slack echo.
 *
 * Endpoints (127.0.0.1 only):
 *   POST /notify   {project, from, message, meta?} -> append spool, echo Slack
 *   GET  /health   daemon liveness + config summary
 *   GET  /registry live channel-server registrations
 *   GET  /inbox?project=<path>&limit=N  read a project's spool
 *
 * SIGTERM: graceful stop. SIGHUP: reload config (Slack webhook, echo mode).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { type Config, loadConfig } from "./config.ts";
import { LOG_PATH, PID_PATH, canonicalProject, ensureDirs } from "./paths.ts";
import { listLive } from "./registry.ts";
import { type Message, appendMessage, readMessages } from "./spool.ts";

let config: Config = loadConfig();

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  appendFileSync(LOG_PATH, stamped);
}

async function echoToSlack(msg: Message): Promise<void> {
  if (config.slackEcho === "none" || !config.slackWebhook) return;
  const project = msg.project.split("/").filter(Boolean).pop() ?? msg.project;
  const listeners = listLive().some(
    (r) => canonicalProject(r.cwd) === msg.project,
  );
  const delivery = listeners ? "" : " _(no session listening; spooled)_";
  const text = `:mailbox: [${project}] *${msg.from}*: ${msg.message}${delivery}`;
  const resp = await fetch(config.slackWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
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
      return json(readMessages(canonicalProject(project), limit));
    }

    if (req.method === "POST" && url.pathname === "/notify") {
      let body: Partial<Message>;
      try {
        body = (await req.json()) as Partial<Message>;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!body.project || !body.message) {
        return json({ error: "required fields: project, message" }, 400);
      }
      const msg: Message = {
        ts: new Date().toISOString(),
        from: body.from ?? "unknown",
        project: canonicalProject(body.project),
        message: body.message,
        ...(body.meta ? { meta: body.meta } : {}),
      };
      const path = appendMessage(msg);
      log(`notify from=${msg.from} project=${msg.project}`);
      await echoToSlack(msg);
      return json({ ok: true, spool: path });
    }

    return json({ error: "not found" }, 404);
  },
});

log(`daemon started pid=${process.pid} port=${config.port}`);

process.on("SIGHUP", () => {
  config = loadConfig();
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
