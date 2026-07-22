#!/usr/bin/env bun
/** agent-mail channel server: spawned by the host (Claude Code or Codex) per
 * session over stdio as an MCP server.
 *
 * - Declares the `claude/channel` capability; new spool lines for this
 *   session's project are pushed into the session as <channel> events.
 *   (Push requires launching Claude Code with
 *   `--dangerously-load-development-channels server:agent-mail` during the
 *   channels research preview; Codex has no channel push, but the tools work.)
 * - Registers {cwd, pid, sessionId, name, client} in the registry so peers and
 *   the daemon can see which sessions are listening. sessionId comes from
 *   CLAUDE_CODE_SESSION_ID (Codex sets no session env var, so it falls back to a
 *   per-process random uuid); name from Claude Code's session metadata; client
 *   ("claude-code"/"codex") from the MCP clientInfo once the handshake lands.
 * - Tools: send_mail, list_sessions, check_inbox, and mark_read.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.ts";
import {
  canonicalProject,
  displayName,
  ensureDirs,
  spoolPath,
} from "./paths.ts";
import { listLive, register, unregister } from "./registry.ts";
import { claudeSessions, sessionDisplayName, sessionName } from "./sessions.ts";
import {
  type Message,
  appendMessage,
  markAllMessagesRead,
  markMessagesRead,
  readMessages,
} from "./spool.ts";

const cwd = canonicalProject(process.cwd());
// Per-session identifier. Claude Code sets CLAUDE_CODE_SESSION_ID in the MCP
// server's environment (correlates to the transcript filename and `--resume`);
// fall back to a constructed id for older Claude Code versions that don't.
// Used to distinguish multiple sessions in the same directory (which share one
// spool) and to suppress self-echo of our own outgoing mail.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? randomUUID();
const myName = sessionName(sessionId);
const myLabel = sessionDisplayName(sessionId, myName);
const selfLabel = `${myLabel} (${sessionId})`;
const config = loadConfig();
const mySpool = spoolPath(cwd);

/** Live sessions (pid-pruned registry), enriched with fresh Claude Code names.
 * Only entries with a known sessionId are returned — older sessions that
 * predate CLAUDE_CODE_SESSION_ID can't be addressed individually. */
function liveSessions(dir?: string): {
  sessionId: string;
  cwd: string;
  name: string;
  status?: string;
  client?: string;
  pid: number;
}[] {
  const meta = claudeSessions();
  return listLive()
    .filter((r) => r.sessionId && (!dir || canonicalProject(r.cwd) === dir))
    .map((r) => {
      const sid = r.sessionId as string;
      const name = meta.get(sid)?.name ?? r.name;
      return {
        sessionId: sid,
        cwd: canonicalProject(r.cwd),
        name: sessionDisplayName(sid, name),
        status: meta.get(sid)?.status,
        client: r.client,
        pid: r.pid,
      };
    });
}

/** One-line snippet of a message body, for reply previews. */
function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeSessions(
  sessions: {
    sessionId: string;
    name: string;
    status?: string;
    client?: string;
  }[],
): string {
  return sessions
    .map(
      (s) =>
        `  - ${s.name} (${s.sessionId})${s.client ? ` <${s.client}>` : ""}${s.status ? ` [${s.status}]` : ""}`,
    )
    .join("\n");
}

const mcp = new Server(
  { name: "agent-mail", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `Local mail between coding agents. You are session ${selfLabel} in ${cwd}. Use check_inbox for recent/unread mail, mark_read after acting, and send_mail to contact another project. Multiple sessions in one directory share an inbox; to reach a specific one, pass its name or id as \`session\` to send_mail, and use list_sessions to discover targets.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_mail",
      description:
        "Send a message to another project's agent-mail inbox. By default " +
        "every session in the target directory sees it; pass `session` to " +
        "address one specific session. To continue a conversation, pass " +
        "`reply_to` with the id of the message you are answering (ids are " +
        "shown by check_inbox) — the reply is grouped into the same thread.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Target project directory (absolute path)",
          },
          message: { type: "string", description: "The message" },
          session: {
            type: "string",
            description:
              "Optional: name or id of a specific session in the target " +
              "directory (see list_sessions). Omit to reach all sessions there.",
          },
          reply_to: {
            type: "string",
            description:
              "Optional: id of the message this answers (from check_inbox). " +
              "Threads the reply with the original.",
          },
        },
        required: ["project", "message"],
      },
    },
    {
      name: "list_sessions",
      description:
        "List live agent sessions (mail targets) and their names/ids. " +
        "Optionally scope to one project directory.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Optional: only list sessions in this directory",
          },
        },
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
          unread: {
            type: "boolean",
            description: "Only return unread messages",
          },
        },
      },
    },
    {
      name: "mark_read",
      description: "Mark this project's agent-mail messages read.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Message ids to mark read",
          },
          all: {
            type: "boolean",
            description: "Mark all current messages read",
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
    const { project, message, session, reply_to } = req.params.arguments as {
      project: string;
      message: string;
      session?: string;
      reply_to?: string;
    };
    const target = canonicalProject(project);
    const meta: Record<string, string> = { sessionId };
    meta.fromName = myLabel;
    let replyTo: string | undefined;
    let threadId: string | undefined;
    if (reply_to) {
      replyTo = reply_to;
      // The message being answered was received here, so it lives in our own
      // inbox. Inherit its thread and carry a preview for the Slack echo.
      const parent = readMessages(cwd, { limit: 0 }).find(
        (m) => m.id === reply_to,
      );
      threadId = parent?.threadId ?? parent?.id ?? reply_to;
      if (parent) {
        meta.replyToFrom = displayName(parent.from);
        meta.replyToPreview = preview(parent.message);
      }
    }
    if (session) {
      const peers = liveSessions(target);
      const matches = peers.filter(
        (p) => p.sessionId === session || p.name === session,
      );
      if (matches.length === 0) {
        const tail = peers.length
          ? `Live sessions in that directory:\n${describeSessions(peers)}`
          : "No sessions are listening in that directory.";
        return {
          content: [
            {
              type: "text",
              text: `no live session "${session}" in ${target}. ${tail}`,
            },
          ],
        };
      }
      if (matches.length > 1) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${session}" is ambiguous — multiple sessions match; ` +
                `resend with the exact id:\n${describeSessions(matches)}`,
            },
          ],
        };
      }
      meta.toSession = matches[0].sessionId;
    }
    const status = await deliver({
      ts: new Date().toISOString(),
      from: cwd,
      project: target,
      message,
      ...(replyTo ? { replyTo } : {}),
      ...(threadId ? { threadId } : {}),
      meta,
    });
    return { content: [{ type: "text", text: status }] };
  }
  if (req.params.name === "list_sessions") {
    const { project } = (req.params.arguments ?? {}) as { project?: string };
    const dir = project ? canonicalProject(project) : undefined;
    const sessions = liveSessions(dir);
    return {
      content: [
        {
          type: "text",
          text: sessions.length
            ? sessions
                .map(
                  (s) =>
                    `${s.name} (${s.sessionId})${s.client ? ` <${s.client}>` : ""} — ${s.cwd}${s.status ? ` [${s.status}]` : ""}${s.sessionId === sessionId ? " (you)" : ""}`,
                )
                .join("\n")
            : "no sessions listening",
        },
      ],
    };
  }
  if (req.params.name === "check_inbox") {
    const { limit, unread } = (req.params.arguments ?? {}) as {
      limit?: number;
      unread?: boolean;
    };
    const messages = readMessages(cwd, {
      limit: limit ?? 20,
      unreadOnly: unread ?? false,
    });
    return {
      content: [
        {
          type: "text",
          text: messages.length
            ? messages
                .map((m) => {
                  const sender =
                    m.meta?.fromName ?? m.meta?.sessionId?.slice(0, 8);
                  const tag = sender ? ` [${sender}]` : "";
                  const direct =
                    m.meta?.toSession === sessionId ? " (to you)" : "";
                  const reply = m.replyTo ? ` ↩${m.replyTo.slice(0, 8)}` : "";
                  return `${m.id} ${m.read ? "read" : "unread"} [${m.ts}] from ${displayName(m.from)}${tag}${direct}${reply}: ${m.message}`;
                })
                .join("\n")
            : "inbox empty",
        },
      ],
    };
  }
  if (req.params.name === "mark_read") {
    const { ids, all } = (req.params.arguments ?? {}) as {
      ids?: string[];
      all?: boolean;
    };
    let count: number;
    if (all === true) {
      count = markAllMessagesRead(cwd);
    } else {
      if (!Array.isArray(ids)) {
        throw new Error("mark_read requires ids or all=true");
      }
      count = markMessagesRead(cwd, ids);
    }
    return {
      content: [{ type: "text", text: `marked ${count} message(s) read` }],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// Once the client completes the MCP handshake, its clientInfo tells us which
// host we're under ("claude-code", "codex", ...). Re-register with it; this is
// the only reliable claude-vs-codex signal, since Codex sets no session env var.
mcp.oninitialized = () => {
  const client = mcp.getClientVersion()?.name;
  if (client) register(cwd, process.pid, sessionId, myName, client);
};

await mcp.connect(new StdioServerTransport());

ensureDirs();
register(cwd, process.pid, sessionId, myName);

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
    // Skip our own mail: same directory shares one spool, so a message we sent
    // to this project would otherwise be pushed back into our own session.
    if (msg.meta?.sessionId === sessionId) continue;
    // Honor session-targeted mail: a message addressed to another session in
    // this shared-spool directory is not for us.
    if (msg.meta?.toSession && msg.meta.toSession !== sessionId) continue;
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
