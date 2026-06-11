#!/usr/bin/env bun
/** agent-mail channel server: spawned by Claude Code per session (stdio MCP).
 *
 * - Declares the `claude/channel` capability; new spool lines for this
 *   session's project are pushed into the session as <channel> events.
 *   (Push requires launching Claude Code with
 *   `--dangerously-load-development-channels server:agent-mail` during the
 *   channels research preview; without the flag this is an inert MCP server
 *   whose tools still work.)
 * - Registers {cwd, pid} in the registry so peers and the daemon can see
 *   which sessions are listening.
 * - Tools: send_mail (message another project via the daemon, falling back
 *   to a direct spool append) and check_inbox (read this project's spool).
 */

import { existsSync, statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.ts";
import { canonicalProject, ensureDirs, spoolPath } from "./paths.ts";
import { register, unregister } from "./registry.ts";
import { type Message, appendMessage, readMessages } from "./spool.ts";

const cwd = canonicalProject(process.cwd());
const config = loadConfig();
const mySpool = spoolPath(cwd);

const mcp = new Server(
  { name: "agent-mail", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "agent-mail is the local mail bus between Claude Code sessions and " +
      "tools like weft. Inbound messages arrive as " +
      '<channel source="agent-mail" from="..." ts="...">; read them and act ' +
      "(job-completion notices from weft usually mean: process the job's " +
      "results). To message another project's agent, call send_mail with " +
      "the target project directory. check_inbox reads this project's " +
      "recent mail, e.g. at session start.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_mail",
      description:
        "Send a message to another project's agent-mail inbox (delivered " +
        "live if a session is listening there, spooled otherwise; echoed " +
        "to Slack).",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Target project directory (absolute path)",
          },
          message: { type: "string", description: "The message" },
        },
        required: ["project", "message"],
      },
    },
    {
      name: "check_inbox",
      description: "Read this project's recent agent-mail messages.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max messages to return (default 20)",
          },
        },
      },
    },
  ],
}));

async function deliver(msg: Message): Promise<string> {
  // Prefer the daemon (gets the Slack echo); fall back to direct append.
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return "sent via daemon (Slack echoed)";
  } catch {
    // daemon down; fall through
  }
  appendMessage(msg);
  return "daemon unreachable; spooled directly (no Slack echo)";
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "send_mail") {
    const { project, message } = req.params.arguments as {
      project: string;
      message: string;
    };
    const status = await deliver({
      ts: new Date().toISOString(),
      from: cwd,
      project: canonicalProject(project),
      message,
    });
    return { content: [{ type: "text", text: status }] };
  }
  if (req.params.name === "check_inbox") {
    const { limit } = (req.params.arguments ?? {}) as { limit?: number };
    const messages = readMessages(cwd, limit ?? 20);
    return {
      content: [
        {
          type: "text",
          text: messages.length
            ? messages
                .map((m) => `[${m.ts}] from ${m.from}: ${m.message}`)
                .join("\n")
            : "inbox empty",
        },
      ],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

ensureDirs();
register(cwd, process.pid);

// --- Spool watcher: push lines appended after startup -----------------------
let offset = existsSync(mySpool) ? statSync(mySpool).size : 0;

async function poll(): Promise<void> {
  if (!existsSync(mySpool)) return;
  const size = statSync(mySpool).size;
  if (size < offset) offset = 0; // spool was truncated/rotated
  if (size === offset) return;
  const file = Bun.file(mySpool);
  const chunk = await file.slice(offset, size).text();
  offset = size;
  for (const line of chunk.split("\n").filter(Boolean)) {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.message,
        meta: {
          from: msg.from,
          ts: msg.ts,
          ...(msg.meta ?? {}),
        },
      },
    });
  }
}

const timer = setInterval(() => void poll(), 1000);

function shutdown(): void {
  clearInterval(timer);
  unregister(cwd, process.pid);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("close", shutdown);
process.stdin.on("end", shutdown);
