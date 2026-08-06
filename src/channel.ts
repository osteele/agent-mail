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
 * - Tools: send_mail, list_sessions, check_inbox, mark_read, and
 *   mute_notifications / unmute_notifications (pause/resume this session's
 *   channel push — mail keeps spooling while muted and flushes on unmute),
 *   plus experiment-number and file/directory coordination claims.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type Claim, claims } from "./claims.ts";
import { loadConfig } from "./config.ts";
import {
  canonicalProject,
  displayName,
  ensureDirs,
  spoolPath,
} from "./paths.ts";
import {
  isMuted,
  listLive,
  register,
  setMuted,
  touch,
  unregister,
} from "./registry.ts";
import {
  activityTag,
  claudeSessions,
  lastActivityMs,
  sessionDisplayName,
} from "./sessions.ts";
import {
  type Message,
  appendMessage,
  markMessagesRead,
  messageVisibleToSession,
  readMessages,
} from "./spool.ts";

const cwd = canonicalProject(process.cwd());
// Per-session identifier. Claude Code sets CLAUDE_CODE_SESSION_ID in the MCP
// server's environment (correlates to the transcript filename and `--resume`);
// fall back to a constructed id for older Claude Code versions that don't.
// Used to distinguish multiple sessions in the same directory (which share one
// spool) and to suppress self-echo of our own outgoing mail.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? randomUUID();
const myMeta = claudeSessions().get(sessionId);
const myName = myMeta?.name; // raw Claude name for the registry snapshot
const myLabel = sessionDisplayName(sessionId, myMeta, cwd);
const selfLabel = `${myLabel} (${sessionId})`;
const config = loadConfig();
const mySpool = spoolPath(cwd);
const claimOwner = {
  id: sessionId,
  label: myLabel,
  sessionId,
  pid: process.pid,
};

/** Live sessions (pid-pruned registry), enriched with fresh Claude Code names.
 * Only entries with a known sessionId are returned — older sessions that
 * predate CLAUDE_CODE_SESSION_ID can't be addressed individually. */
function liveSessions(dir?: string): {
  sessionId: string;
  cwd: string;
  name: string;
  activity: string;
  client?: string;
  muted?: boolean;
  pid: number;
}[] {
  const meta = claudeSessions();
  return listLive()
    .filter((r) => r.sessionId && (!dir || canonicalProject(r.cwd) === dir))
    .map((r) => {
      const sid = r.sessionId as string;
      const m = meta.get(sid);
      // Live Claude meta + cwd; skip the possibly-stale registry `name` snapshot
      // so a session reads as its aliased base + readable suffix.
      return {
        sessionId: sid,
        cwd: canonicalProject(r.cwd),
        name: sessionDisplayName(sid, m, canonicalProject(r.cwd)),
        activity: activityTag(m?.status, lastActivityMs(r, m)),
        client: r.client,
        muted: r.muted,
        pid: r.pid,
      };
    });
}

/** One-line snippet of a message body, for reply previews. */
function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sessionMessages(opts: {
  limit?: number;
  unreadOnly?: boolean;
}): ReturnType<typeof readMessages> {
  const all = readMessages(cwd, {
    limit: 0,
    unreadOnly: opts.unreadOnly ?? false,
  }).filter((msg) => messageVisibleToSession(msg, sessionId));
  const limit = opts.limit ?? 20;
  return limit > 0 ? all.slice(-limit) : all;
}

function describeSessions(
  sessions: {
    sessionId: string;
    name: string;
    activity: string;
    client?: string;
    muted?: boolean;
  }[],
): string {
  return sessions
    .map(
      (s) =>
        `  - ${s.name} (${s.sessionId})${s.client ? ` <${s.client}>` : ""} [${s.activity}]${s.muted ? " [muted]" : ""}`,
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
    instructions: `Local mail and filesystem coordination between coding agents. You are session ${selfLabel} in ${cwd}. Use check_inbox for recent/unread mail, mark_read after acting, and send_mail to contact another project. Multiple sessions in one directory share an inbox; to reach a specific one, pass its name or id as \`session\` to send_mail, and use list_sessions to discover targets. Before creating a lab-notebook experiment, call claim_experiment; before editing a file or directory another agent may touch, call claim_path. Release each claim after creating the experiment file or finishing the edit. Call mute_notifications to pause channel push (incoming mail keeps spooling and stays visible to check_inbox); unmute_notifications flushes anything held and resumes push.`,
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
        "List attached agent sessions (mail targets) and their names/ids. " +
        "Optionally scope to one project directory. Attached does not mean " +
        "active: each entry shows how recently the session did anything " +
        "(busy / active / idle <age>) — treat long-idle sessions as probably " +
        "vacant even though mail to them will be delivered.",
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
    {
      name: "mute_notifications",
      description:
        "Pause channel push for this session. Incoming mail keeps spooling " +
        "and stays visible to check_inbox, but is not pushed as a channel " +
        "event. When you unmute, everything held is delivered at once.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "unmute_notifications",
      description:
        "Resume channel push for this session, delivering any messages that " +
        "arrived while muted.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "claim_experiment",
      description:
        "Atomically reserve the next sequential EXP-NNN number in a research " +
        "lab notebook. The default notebook is ./lab-notebook when present, " +
        "otherwise the project root. Create the experiment file, then call " +
        "release_claim with the returned claim id; the file keeps the number reserved.",
      inputSchema: {
        type: "object",
        properties: {
          notebook: {
            type: "string",
            description:
              "Optional lab-notebook directory, absolute or relative to the project",
          },
        },
      },
    },
    {
      name: "claim_path",
      description:
        "Claim a project file or directory before editing it. A directory " +
        "claim conflicts with claims on any descendant; all claims conflict " +
        "with a claimed ancestor. Release it when the edit or handoff is complete.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project path, absolute or relative to the project",
          },
          directory: {
            type: "boolean",
            description:
              "Claim the path as a directory (default false; required for a nonexistent directory)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_claims",
      description:
        "List active experiment-number and path claims for this project, including owners and claim ids.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "release_claim",
      description:
        "Release one of this session's experiment-number or path claims by claim id.",
      inputSchema: {
        type: "object",
        properties: {
          claim_id: { type: "string", description: "Claim id to release" },
        },
        required: ["claim_id"],
      },
    },
  ],
}));

function describeClaim(claim: Claim): string {
  const resource =
    claim.type === "experiment"
      ? `${claim.experimentId} (${claim.notebook})`
      : `${claim.pathType} ${claim.path}`;
  return `${claim.id} ${resource} — ${claim.owner.label} [${claim.createdAt}]`;
}

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
  // Every tool call is a sign of life; stamp it so peers see fresh idle times
  // (Codex sessions have no Claude session meta, so this is their only signal).
  touch(cwd, process.pid);
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
      const parent = sessionMessages({ limit: 0 }).find(
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
                    `${s.name} (${s.sessionId})${s.client ? ` <${s.client}>` : ""} — ${s.cwd} [${s.activity}]${s.muted ? " [muted]" : ""}${s.sessionId === sessionId ? " (you)" : ""}`,
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
    const messages = sessionMessages({
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
      const unread = sessionMessages({ limit: 0, unreadOnly: true });
      count = markMessagesRead(
        cwd,
        unread.map((msg) => msg.id),
      );
    } else {
      if (!Array.isArray(ids)) {
        throw new Error("mark_read requires ids or all=true");
      }
      const available = new Set(sessionMessages({ limit: 0 }).map((m) => m.id));
      count = markMessagesRead(
        cwd,
        ids.filter((id) => available.has(id)),
      );
    }
    return {
      content: [{ type: "text", text: `marked ${count} message(s) read` }],
    };
  }
  if (req.params.name === "mute_notifications") {
    setMuted(cwd, process.pid, true);
    return {
      content: [
        {
          type: "text",
          text: "channel notifications paused; incoming mail keeps spooling (visible to check_inbox) and flushes when you unmute",
        },
      ],
    };
  }
  if (req.params.name === "unmute_notifications") {
    setMuted(cwd, process.pid, false);
    return {
      content: [
        {
          type: "text",
          text: "channel notifications on; any messages held while muted will be delivered now",
        },
      ],
    };
  }
  if (req.params.name === "claim_experiment") {
    const { notebook } = (req.params.arguments ?? {}) as { notebook?: string };
    const notebookPath = notebook
      ? resolve(cwd, notebook)
      : existsSync(join(cwd, "lab-notebook"))
        ? join(cwd, "lab-notebook")
        : cwd;
    const claim = claims.claimExperiment(cwd, notebookPath, claimOwner);
    return {
      content: [
        {
          type: "text",
          text: `${claim.experimentId} claimed (claim ${claim.id}). Create the experiment file, then release this claim.`,
        },
      ],
    };
  }
  if (req.params.name === "claim_path") {
    const { path, directory } = req.params.arguments as {
      path: string;
      directory?: boolean;
    };
    const claim = claims.claimPath(
      cwd,
      resolve(cwd, path),
      directory ? "directory" : "file",
      claimOwner,
    );
    return {
      content: [
        {
          type: "text",
          text: `${claim.pathType} claimed: ${claim.path} (claim ${claim.id})`,
        },
      ],
    };
  }
  if (req.params.name === "list_claims") {
    const active = claims.list(cwd);
    return {
      content: [
        {
          type: "text",
          text: active.length
            ? active.map(describeClaim).join("\n")
            : "no active claims",
        },
      ],
    };
  }
  if (req.params.name === "release_claim") {
    const { claim_id } = req.params.arguments as { claim_id: string };
    const claim = claims.release(cwd, claim_id, sessionId);
    return {
      content: [{ type: "text", text: `released ${describeClaim(claim)}` }],
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
  // Muted: leave `offset` where it is so nothing is consumed. New lines pile up
  // in the spool and flush from here on the first poll after unmute.
  if (isMuted(cwd, process.pid)) return;
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
    if (!messageVisibleToSession(msg, sessionId)) continue;
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
  claims.releaseOwner(cwd, sessionId);
  unregister(cwd, process.pid);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("close", shutdown);
process.stdin.on("end", shutdown);
