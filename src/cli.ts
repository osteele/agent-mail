#!/usr/bin/env bun
/** agent-mail CLI.
 *
 * Messaging:
 *   agent-mail notify --project <dir> --message <text> [--from <label>] [--no-slack]
 *   agent-mail inbox [--project <dir>] [--limit N] [--unread]
 *   agent-mail mark-read [--project <dir>] (--id <message-id> | --all)
 *   agent-mail listeners
 *   agent-mail mute|unmute (--session <name-or-id> | --project <dir>)
 *   agent-mail claim-experiment [--project <dir>] [--notebook <dir>]
 *   agent-mail claim-path --path <path> [--directory] [--project <dir>]
 *   agent-mail claims [--project <dir>]
 *   agent-mail release-claim --id <claim-id> [--project <dir>]
 *
 * Dashboards:
 *   agent-mail dashboard [--port N] [--open] [--no-tui]
 *   agent-mail slack-dashboard [--watch <seconds>]
 *
 * Status line:
 *   agent-mail status-line [--project <dir>] [--session <id>] [--debug]
 *
 * Daemon management (launchd-aware: uses launchctl when the LaunchAgent is
 * installed, bare pidfile mode otherwise):
 *   agent-mail start | stop | restart | graceful | status | logs [-f]
 *
 * Setup:
 *   agent-mail install     LaunchAgent (boot start) + Claude mcpServers entry
 *   agent-mail uninstall
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Claim, type ClaimOwner, claims } from "./claims.ts";
import { loadConfig } from "./config.ts";
import { openBrowser, serveDashboard } from "./dashboard.ts";
import {
  addNativeAuditHook,
  claudeRegistrationMatches,
  codexRegistrationMatches,
  removeNativeAuditHook,
} from "./integrations.ts";
import {
  CONFIG_PATH,
  LAUNCHD_LABEL,
  LOG_PATH,
  PID_PATH,
  canonicalProject,
  displayName,
  ensureDirs,
} from "./paths.ts";
import { liveInProject, statusLineName } from "./presence.ts";
import {
  type InboundPolicy,
  type Registration,
  listLive,
  setInboundPolicy,
  setMuted,
} from "./registry.ts";
import {
  activityTag,
  claudeSessions,
  lastActivityMs,
  sessionNames,
} from "./sessions.ts";
import {
  SlackDashboardUnconfigured,
  refreshSlackDashboard,
} from "./slackDashboard.ts";
import {
  appendMessageGuarded,
  knownProjects,
  markAllMessagesRead,
  markMessagesRead,
  readMessages,
  readReceipts,
} from "./spool.ts";

function capabilityTag(r: Registration): string {
  const capabilities = r.capabilities;
  if (!capabilities) return "";
  const labels = [
    capabilities.channelPush ? "channel" : "poll",
    capabilities.nativePeerMessaging ? "native-peer" : undefined,
    capabilities.claims ? "claims" : undefined,
    capabilities.receipts ? "receipts" : undefined,
  ].filter(Boolean);
  return labels.length ? ` {${labels.join(",")}}` : "";
}

/** Human-facing display name followed by the stable full-name address. */
function sessionLabel(
  r: { sessionId?: string; client?: string; cwd: string },
  names = claudeSessions(),
): string {
  if (!r.sessionId) return r.client ?? "unnamed";
  const identity = sessionNames(r.sessionId, names.get(r.sessionId), r.cwd);
  return identity.displayName === identity.fullName
    ? identity.fullName
    : `${identity.displayName} (${identity.fullName})`;
}

function matchesSessionName(
  registration: Registration,
  query: string,
  names = claudeSessions(),
): boolean {
  if (registration.sessionId === query) return true;
  if (!registration.sessionId) return false;
  const identity = sessionNames(
    registration.sessionId,
    names.get(registration.sessionId),
    registration.cwd,
  );
  return (
    identity.fullName === query ||
    identity.displayName.toLocaleLowerCase() === query.toLocaleLowerCase()
  );
}

/** Recency tag ("busy" / "active" / "idle 26h — stale?") for a registry entry. */
function sessionActivity(r: Registration, names = claudeSessions()): string {
  const meta = r.sessionId ? names.get(r.sessionId) : undefined;
  return activityTag(meta?.status, lastActivityMs(r, meta));
}

const SRC_DIR = dirname(new URL(import.meta.url).pathname);
const DAEMON_TS = join(SRC_DIR, "daemon.ts");
const CHANNEL_TS = join(SRC_DIR, "channel.ts");
const NATIVE_AUDIT_TS = join(SRC_DIR, "nativeAudit.ts");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "settings.json",
);

function bunPath(): string {
  return process.execPath; // the bun binary running this script
}

// --- argument parsing --------------------------------------------------------

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

// --- daemon process management ----------------------------------------------

function daemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function launchdInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

function launchctl(...args: string[]): string {
  return execFileSync("launchctl", args, { encoding: "utf8" });
}

function guiDomain(): string {
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  return `gui/${uid}`;
}

function cmdStart(): void {
  if (daemonPid() !== null) {
    console.log(`daemon already running (pid ${daemonPid()})`);
    return;
  }
  if (launchdInstalled()) {
    launchctl("bootstrap", guiDomain(), PLIST_PATH);
    console.log("daemon started via launchd");
  } else {
    ensureDirs();
    const child = spawn(bunPath(), [DAEMON_TS], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`daemon started (pid ${child.pid}, bare mode)`);
  }
}

function cmdStop(): void {
  const pid = daemonPid();
  if (launchdInstalled()) {
    try {
      launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
      console.log("daemon stopped (launchd bootout)");
      return;
    } catch {
      // not bootstrapped; fall through to pid kill
    }
  }
  if (pid === null) {
    console.log("daemon not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  console.log(`daemon stopped (pid ${pid})`);
}

function cmdRestart(): void {
  if (launchdInstalled() && daemonPid() !== null) {
    launchctl("kickstart", "-k", `${guiDomain()}/${LAUNCHD_LABEL}`);
    console.log("daemon restarted (launchd kickstart)");
    return;
  }
  cmdStop();
  // brief pause for the port to free
  Bun.sleepSync(500);
  cmdStart();
}

function cmdGraceful(): void {
  const pid = daemonPid();
  if (pid === null) {
    console.log("daemon not running");
    return;
  }
  process.kill(pid, "SIGHUP");
  console.log(`daemon reloaded config (SIGHUP to pid ${pid})`);
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pid = daemonPid();
  console.log(`daemon: ${pid === null ? "stopped" : `running (pid ${pid})`}`);
  console.log(`launchd: ${launchdInstalled() ? "installed" : "not installed"}`);
  console.log(`port: ${config.port}`);
  console.log(
    `slack echo: ${config.slackWebhook ? config.slackEcho : "unconfigured"}`,
  );
  if (pid !== null) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      console.log(`health: ${resp.ok ? "ok" : `HTTP ${resp.status}`}`);
    } catch {
      console.log("health: NOT RESPONDING (pid alive but port dead)");
    }
  }
  const live = listLive();
  const names = claudeSessions();
  console.log(`listening sessions: ${live.length}`);
  for (const r of live)
    console.log(
      `  ${sessionLabel(r, names)}${capabilityTag(r)} — ${r.cwd} (pid ${r.pid}) [${sessionActivity(r, names)}] [inbound:${r.inboundPolicy ?? "accept"}]${r.muted ? " [muted]" : ""}`,
    );
}

function cmdLogs(follow: boolean): void {
  if (!existsSync(LOG_PATH)) {
    console.log("no log file yet");
    return;
  }
  if (follow) {
    const child = spawn("tail", ["-f", LOG_PATH], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill());
  } else {
    const lines = readFileSync(LOG_PATH, "utf8").split("\n");
    console.log(lines.slice(-50).join("\n"));
  }
}

// --- messaging ----------------------------------------------------------------

/** Resolve a --project argument to an existing project directory.
 *
 * An existing path resolves directly. A bare name (or nonexistent path) is
 * matched by basename against live listeners and projects that have received
 * mail before — this catches the footgun where a relative path silently
 * resolves against the terminal's cwd and spools to a phantom project.
 */
function resolveProjectArg(arg: string): string {
  const direct = canonicalProject(arg);
  if (existsSync(direct)) return direct;

  const name = arg.split("/").filter(Boolean).pop() ?? arg;
  const candidates = new Set<string>();
  for (const r of listLive()) {
    const cwd = canonicalProject(r.cwd);
    if (cwd.split("/").pop() === name) candidates.add(cwd);
  }
  for (const project of knownProjects()) {
    if (project.split("/").pop() === name) candidates.add(project);
  }

  if (candidates.size === 1) {
    const resolved = [...candidates][0];
    console.error(`resolved project "${arg}" -> ${resolved}`);
    return resolved;
  }
  if (candidates.size > 1) {
    console.error(`project "${arg}" is ambiguous; use a full path:`);
    for (const c of candidates) console.error(`  ${c}`);
  } else {
    console.error(
      `project "${arg}" does not exist (resolved to ${direct}) and matches no live listener or known project. Use an absolute path.`,
    );
  }
  process.exit(1);
}

async function cmdNotify(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const project = flags.project;
  const message = flags.message;
  if (typeof project !== "string" || typeof message !== "string") {
    console.error(
      "usage: agent-mail notify --project <dir> --message <text> [--from <label>] [--reply-to <id>] [--idempotency-key <key>] [--ttl <seconds>] [--no-slack]",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const resolvedProject = resolveProjectArg(project);
  const replyTo =
    typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined;
  const idempotencyKey =
    typeof flags["idempotency-key"] === "string"
      ? flags["idempotency-key"]
      : undefined;
  const ttlSeconds =
    typeof flags.ttl === "string" ? Number(flags.ttl) : undefined;
  if (
    ttlSeconds !== undefined &&
    (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
  ) {
    console.error("--ttl must be a non-negative number of seconds");
    process.exit(1);
  }
  const from = typeof flags.from === "string" ? flags.from : "cli";
  const suppressSlack = flags["no-slack"] === true;
  const body = JSON.stringify({
    project: resolvedProject,
    message,
    from,
    origin: {
      kind: "automation",
      transport: "cli",
      authority: "untrusted",
    },
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(suppressSlack ? { slackEcho: false } : {}),
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const result = (await resp.json()) as { status?: string; id?: string };
      console.log(
        result.status === "duplicate"
          ? `duplicate suppressed (${result.id})`
          : `spooled ${result.id ?? "unknown"} via daemon`,
      );
      return;
    }
    console.error(`daemon error: HTTP ${resp.status} ${await resp.text()}`);
    process.exit(1);
  } catch {
    // Daemon down: append directly so the message is not lost.
    const result = appendMessageGuarded(
      {
        ts: new Date().toISOString(),
        from,
        project: resolvedProject,
        message,
        origin: {
          kind: "automation",
          transport: "cli",
          authority: "untrusted",
        },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(ttlSeconds !== undefined
          ? {
              expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
            }
          : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(suppressSlack ? { slackEcho: false } : {}),
      },
      {
        duplicateWindowSeconds: config.duplicateWindowSeconds,
        messageRateLimitPerMinute: config.messageRateLimitPerMinute,
        defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
      },
    );
    if (result.status === "rate_limited") {
      console.error(`rate limited; retry in ${result.retryAfterSeconds}s`);
      process.exit(1);
    }
    console.log(
      result.status === "duplicate"
        ? `duplicate suppressed (${result.id})`
        : `daemon unreachable; spooled ${result.id} directly (no Slack echo)`,
    );
  }
}

function cmdInbox(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
  const messages = readMessages(project, {
    limit,
    unreadOnly: flags.unread === true,
  });
  if (messages.length === 0) {
    console.log("inbox empty");
    return;
  }
  for (const m of messages) {
    const reply = m.replyTo ? ` ↩${m.replyTo.slice(0, 8)}` : "";
    console.log(
      `${m.id} ${m.read ? "read" : "unread"} [${m.ts}] from ${displayName(m.from)}${reply}: ${m.message}`,
    );
  }
}

function cmdMarkRead(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  if (flags.all === true) {
    console.log(`marked ${markAllMessagesRead(project)} message(s) read`);
    return;
  }
  if (typeof flags.id !== "string") {
    console.error(
      "usage: agent-mail mark-read [--project <dir>] (--id <message-id> | --all)",
    );
    process.exit(1);
  }
  console.log(
    `marked ${markMessagesRead(project, [flags.id])} message(s) read`,
  );
}

function cmdReceipts(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const messageId = typeof flags.id === "string" ? flags.id : undefined;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
  const receipts = readReceipts(project, messageId).slice(-limit);
  if (receipts.length === 0) {
    console.log("no delivery receipts");
    return;
  }
  for (const receipt of receipts) {
    console.log(
      `${receipt.messageId} ${receipt.status} [${receipt.ts}]${receipt.sessionId ? ` session=${receipt.sessionId}` : ""}${receipt.detail ? ` (${receipt.detail})` : ""}`,
    );
  }
}

function cmdListeners(): void {
  const live = listLive();
  if (live.length === 0) {
    console.log("no sessions listening");
    return;
  }
  const names = claudeSessions();
  for (const r of live) {
    console.log(
      `${sessionLabel(r, names)}${capabilityTag(r)} — ${r.cwd} (pid ${r.pid}, since ${r.started}) [${sessionActivity(r, names)}] [inbound:${r.inboundPolicy ?? "accept"}]${r.muted ? " [muted]" : ""}`,
    );
  }
}

// --- status line -------------------------------------------------------------

/** The part of Claude Code's statusLine payload this command reads. */
interface StatusLinePayload {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
}

/** Read the statusLine payload from stdin when there is one.
 *
 * The tty guard matters: Claude Code pipes the payload in, but someone running
 * this by hand has an interactive stdin and would otherwise hang waiting for
 * input that never comes. */
async function readStatusLinePayload(): Promise<StatusLinePayload | undefined> {
  if (process.stdin.isTTY) return undefined;
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? (JSON.parse(text) as StatusLinePayload) : undefined;
  } catch {
    // Not JSON, or nothing arrived. Fall through to the flags rather than
    // failing — this command's job is to stay out of the way.
    return undefined;
  }
}

/** Print this session's display name when another live agent shares the
 * project, and nothing at all when it is alone.
 *
 * Always exits 0, including on error. The consumer is a shell substitution
 * inside a status-line script (`name=$(agent-mail status-line)`), where a
 * non-zero exit is hazardous under `set -e` and any stray output corrupts the
 * user's prompt. Empty output is already the signal for "nothing to show".
 *
 * Resolves the project with `canonicalProject` rather than `resolveProjectArg`:
 * this addresses no mailbox, and `resolveProjectArg` both rejects unknown
 * directories and runs a full process scan, neither of which belongs on a path
 * that re-runs several times a second. */
async function cmdStatusLine(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const debug = flags.debug === true;
  try {
    const payload = await readStatusLinePayload();
    const project = canonicalProject(
      typeof flags.project === "string"
        ? flags.project
        : (payload?.workspace?.project_dir ??
            payload?.workspace?.current_dir ??
            payload?.cwd ??
            process.cwd()),
    );
    const sessionId =
      typeof flags.session === "string"
        ? flags.session
        : (payload?.session_id ?? process.env.CLAUDE_CODE_SESSION_ID);
    const sessions = liveInProject(project);
    const names = claudeSessions();
    const name = statusLineName(
      sessions,
      project,
      sessionId,
      names,
      Date.now(),
    );
    if (debug) {
      console.error(`project: ${project}`);
      console.error(`session: ${sessionId ?? "(no session id)"}`);
      for (const r of sessions) {
        console.error(
          `  ${r.sessionId ?? "-"} pid ${r.pid} [${sessionActivity(r, names)}]`,
        );
      }
    }
    if (name) console.log(name);
  } catch (error) {
    if (debug) console.error(`status-line failed: ${error}`);
  }
}

// --- coordination claims -----------------------------------------------------

function claimProject(flags: Record<string, string | boolean>): string {
  return typeof flags.project === "string"
    ? resolveProjectArg(flags.project)
    : canonicalProject(process.cwd());
}

function cliOwner(flags: Record<string, string | boolean>): ClaimOwner {
  const label = typeof flags.owner === "string" ? flags.owner : "cli";
  return {
    id:
      typeof flags.owner === "string"
        ? `cli:${flags.owner}`
        : `cli:${process.pid}`,
    label,
    pid: process.pid,
  };
}

function describeClaim(claim: Claim): string {
  const resource =
    claim.type === "experiment"
      ? `${claim.experimentId} (${claim.notebook})`
      : `${claim.pathType} ${claim.path}`;
  return `${claim.id} ${resource} — ${claim.owner.label} [${claim.createdAt}]`;
}

function cmdClaimExperiment(flags: Record<string, string | boolean>): void {
  const project = claimProject(flags);
  const notebook =
    typeof flags.notebook === "string"
      ? resolve(project, flags.notebook)
      : existsSync(join(project, "lab-notebook"))
        ? join(project, "lab-notebook")
        : project;
  const claim = claims.claimExperiment(project, notebook, cliOwner(flags));
  console.log(`${claim.experimentId} ${claim.id}`);
}

function cmdClaimPath(flags: Record<string, string | boolean>): void {
  if (typeof flags.path !== "string") {
    console.error(
      "usage: agent-mail claim-path --path <path> [--directory] [--project <dir>] [--owner <label>]",
    );
    process.exit(1);
  }
  const project = claimProject(flags);
  const claim = claims.claimPath(
    project,
    resolve(project, flags.path),
    flags.directory === true ? "directory" : "file",
    cliOwner(flags),
  );
  console.log(`${claim.id} ${claim.pathType} ${claim.path}`);
}

function cmdClaims(flags: Record<string, string | boolean>): void {
  const active = claims.list(claimProject(flags));
  if (active.length === 0) {
    console.log("no active claims");
    return;
  }
  for (const claim of active) console.log(describeClaim(claim));
}

function cmdReleaseClaim(flags: Record<string, string | boolean>): void {
  if (typeof flags.id !== "string") {
    console.error(
      "usage: agent-mail release-claim --id <claim-id> [--project <dir>]",
    );
    process.exit(1);
  }
  const claim = claims.release(claimProject(flags), flags.id);
  console.log(`released ${describeClaim(claim)}`);
}

// --- mute / unmute ------------------------------------------------------------

/** Live sessions selected by --session (name or id) and/or --project. Requires
 * at least one selector so `mute` never silently targets every session. */
function resolveSessionTargets(
  flags: Record<string, string | boolean>,
  usage: string,
): Registration[] {
  const session = typeof flags.session === "string" ? flags.session : undefined;
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : undefined;
  if (!session && !project) {
    console.error(usage);
    process.exit(1);
  }
  const names = claudeSessions();
  return listLive().filter((r) => {
    if (project && canonicalProject(r.cwd) !== project) return false;
    if (session && !matchesSessionName(r, session, names)) return false;
    return true;
  });
}

function cmdSetMuted(
  flags: Record<string, string | boolean>,
  muted: boolean,
): void {
  const targets = resolveSessionTargets(
    flags,
    "usage: agent-mail mute|unmute (--session <name-or-id> | --project <dir>)",
  );
  const names = claudeSessions();
  if (targets.length === 0) {
    console.error("no matching live session");
    const live = listLive();
    if (live.length) {
      console.error("live sessions:");
      for (const r of live)
        console.error(`  ${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid})`);
    }
    process.exit(1);
  }
  const verb = muted ? "muted" : "unmuted";
  for (const r of targets) {
    setMuted(r.cwd, r.pid, muted);
    console.log(`${verb} ${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid})`);
  }
}

function cmdSetInboundPolicy(flags: Record<string, string | boolean>): void {
  const policy = typeof flags.policy === "string" ? flags.policy : undefined;
  if (policy !== "accept" && policy !== "hold" && policy !== "refuse") {
    console.error(
      "usage: agent-mail inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)",
    );
    process.exit(1);
  }
  const targets = resolveSessionTargets(
    flags,
    "usage: agent-mail inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)",
  );
  if (targets.length === 0) {
    console.error("no matching live session");
    process.exit(1);
  }
  const names = claudeSessions();
  for (const target of targets) {
    setInboundPolicy(target.cwd, target.pid, policy as InboundPolicy);
    console.log(`${sessionLabel(target, names)} — inbound policy ${policy}`);
  }
}

// --- install -------------------------------------------------------------------

function plistContents(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath()}</string>
    <string>${DAEMON_TS}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function registerMcpServer(replace: boolean): void {
  if (!existsSync(CLAUDE_JSON)) {
    console.error(`${CLAUDE_JSON} not found; skipping mcpServers registration`);
    return;
  }
  const doc = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
    string,
    unknown
  >;
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers["agent-mail"];
  if (existing) {
    if (claudeRegistrationMatches(existing, bunPath(), CHANNEL_TS)) {
      console.log("Claude MCP registration already matches this checkout");
      return;
    }
    if (!replace) {
      console.error(
        "Claude already has a different agent-mail MCP entry; leaving it unchanged " +
          "(pass --replace-claude to replace it)",
      );
      return;
    }
  }
  servers["agent-mail"] = {
    type: "stdio",
    command: bunPath(),
    args: [CHANNEL_TS],
    env: {},
  };
  doc.mcpServers = servers;
  writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
  console.log(`registered agent-mail in ${CLAUDE_JSON} mcpServers`);
}

type CodexRegistration =
  | { status: "unavailable" }
  | { status: "absent" }
  | { status: "invalid"; detail: string }
  | { status: "present"; value: unknown };

function codexRegistration(): CodexRegistration {
  const result = spawnSync("codex", ["mcp", "get", "agent-mail", "--json"], {
    encoding: "utf8",
  });
  if (result.error) return { status: "unavailable" };
  if (result.status !== 0) return { status: "absent" };
  try {
    return { status: "present", value: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: "invalid", detail: error.message };
  }
}

function runCodexMcp(args: string[]): boolean {
  const result = spawnSync("codex", ["mcp", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    console.error(`codex unavailable: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(result.stderr.trim() || `codex mcp ${args[0]} failed`);
    return false;
  }
  return true;
}

function registerCodex(replace: boolean): void {
  const registration = codexRegistration();
  if (registration.status === "unavailable") {
    console.error("codex not found; skipping Codex MCP registration");
    return;
  }
  if (registration.status === "invalid") {
    console.error(
      `could not inspect the Codex agent-mail entry: ${registration.detail}`,
    );
    return;
  }
  if (registration.status === "present") {
    if (codexRegistrationMatches(registration.value, bunPath(), CHANNEL_TS)) {
      console.log("Codex MCP registration already matches this checkout");
      return;
    }
    if (!replace) {
      console.error(
        "Codex already has a different agent-mail MCP entry; leaving it unchanged " +
          "(pass --replace-codex to replace it)",
      );
      return;
    }
    if (!runCodexMcp(["remove", "agent-mail"])) return;
  }
  if (runCodexMcp(["add", "agent-mail", "--", bunPath(), CHANNEL_TS])) {
    console.log("registered agent-mail with Codex");
  }
}

function unregisterCodex(): void {
  const registration = codexRegistration();
  if (registration.status === "unavailable") return;
  if (registration.status !== "present") return;
  if (!codexRegistrationMatches(registration.value, bunPath(), CHANNEL_TS)) {
    console.error(
      "Codex agent-mail entry belongs to a different checkout; leaving it unchanged",
    );
    return;
  }
  if (runCodexMcp(["remove", "agent-mail"])) {
    console.log("removed agent-mail from Codex MCP servers");
  }
}

function readClaudeSettings(): Record<string, unknown> {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  const parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${CLAUDE_SETTINGS} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function installNativeAuditHook(): void {
  const result = addNativeAuditHook(
    readClaudeSettings(),
    bunPath(),
    NATIVE_AUDIT_TS,
  );
  if (!result.changed) {
    console.log("Claude native SendMessage audit hook already installed");
    return;
  }
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(
    CLAUDE_SETTINGS,
    `${JSON.stringify(result.document, null, 2)}\n`,
  );
  console.log(`installed native SendMessage audit hook in ${CLAUDE_SETTINGS}`);
}

function uninstallNativeAuditHook(): void {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  const result = removeNativeAuditHook(readClaudeSettings(), NATIVE_AUDIT_TS);
  if (!result.changed) return;
  writeFileSync(
    CLAUDE_SETTINGS,
    `${JSON.stringify(result.document, null, 2)}\n`,
  );
  console.log(`removed native SendMessage audit hook from ${CLAUDE_SETTINGS}`);
}

function cmdInstall(flags: Record<string, string | boolean>): void {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const configTemplate = [
      "# agent-mail config",
      `port = ${loadConfig().port}`,
      '# slack_webhook = "https://hooks.slack.com/services/..." (falls back to ~/.config/weft/config)',
      '# slack_echo = "all"  # or "none"',
      "# Short aliases for long project bases in session labels (comma list):",
      '# session_aliases = "llm-performance-models=augur, dependency-routing=deproute"',
      '# inbound_policy = "accept"  # accept, hold, or refuse',
      "# duplicate_window_seconds = 10",
      "# message_rate_limit_per_minute = 60",
      "# default_message_ttl_seconds = 0  # 0 means no default expiry",
      "# held_message_limit = 100",
      "# Editable Slack dashboard (agent-mail slack-dashboard) needs a bot token:",
      '# slack_bot_token = "xoxb-..."  # chat:write scope; invite the bot to the channel',
      '# slack_channel = "C0123ABCD"',
      "",
    ].join("\n");
    writeFileSync(CONFIG_PATH, configTemplate);
    console.log(`wrote ${CONFIG_PATH}`);
  }
  writeFileSync(PLIST_PATH, plistContents());
  console.log(`wrote ${PLIST_PATH}`);
  try {
    launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
  } catch {
    // not previously loaded
  }
  // Stop any bare-mode daemon so launchd can own the port.
  const pid = daemonPid();
  if (pid !== null) {
    process.kill(pid, "SIGTERM");
    Bun.sleepSync(500);
  }
  launchctl("bootstrap", guiDomain(), PLIST_PATH);
  console.log("daemon bootstrapped via launchd (starts at boot)");
  registerMcpServer(flags["replace-claude"] === true);
  if (flags["no-codex"] !== true) {
    registerCodex(flags["replace-codex"] === true);
  }
  if (flags["native-audit"] === true) installNativeAuditHook();
  console.log(
    "\nTo receive push events, launch Claude Code with:\n" +
      "  claude --dangerously-load-development-channels server:agent-mail",
  );
}

function cmdUninstall(): void {
  try {
    launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
  } catch {
    // not loaded
  }
  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH);
    console.log(`removed ${PLIST_PATH}`);
  }
  if (existsSync(CLAUDE_JSON)) {
    const doc = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
      string,
      unknown
    >;
    const servers = doc.mcpServers as Record<string, unknown> | undefined;
    if (
      servers &&
      claudeRegistrationMatches(servers["agent-mail"], bunPath(), CHANNEL_TS)
    ) {
      const { "agent-mail": _removed, ...rest } = servers;
      doc.mcpServers = rest;
      writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
      console.log("removed agent-mail from mcpServers");
    } else if (servers && "agent-mail" in servers) {
      console.error(
        "Claude agent-mail entry belongs to a different checkout; leaving it unchanged",
      );
    }
  }
  unregisterCodex();
  uninstallNativeAuditHook();
}

function cmdDashboard(flags: Record<string, string | boolean>): void {
  const config = loadConfig();
  const port =
    typeof flags.port === "string" ? Number(flags.port) : config.port + 1;
  const server = serveDashboard(port);
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`agent-mail dashboard → ${url}`);
  if (flags.open === true) openBrowser(url);

  // Single cleanup, idempotent, run on every exit path so the terminal never
  // stays in raw mode.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    server.stop(true);
  };
  process.on("exit", cleanup);

  if (!process.stdin.isTTY || flags["no-tui"] === true) {
    console.log("serving; press Ctrl-C to stop");
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        cleanup();
        process.exit(0);
      });
    }
    return; // keep-alive: the open server handle keeps the event loop running
  }

  console.log("press o to open in browser, q to quit");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    // Raw mode suppresses SIGINT, so Ctrl-C (0x03) arrives as data.
    if (key === "q" || key === "\u0003") {
      cleanup();
      process.stdout.write("\n");
      process.exit(0);
    } else if (key === "o") {
      openBrowser(url);
    }
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}

async function cmdSlackDashboard(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const config = loadConfig();
  const watch = typeof flags.watch === "string" ? Number(flags.watch) : 0;
  try {
    console.log(await refreshSlackDashboard(config));
  } catch (err) {
    if (err instanceof SlackDashboardUnconfigured) {
      console.error(`${err.message}

Set up a Slack app with a bot token (chat:write scope), invite it to the
channel, then add to ${CONFIG_PATH}:
  slack_bot_token = "xoxb-..."
  slack_channel = "C0123ABCD"`);
      process.exit(1);
    }
    throw err;
  }
  if (watch > 0) {
    console.log(`refreshing every ${watch}s; press Ctrl-C to stop`);
    setInterval(() => {
      refreshSlackDashboard(config)
        .then((s) => console.log(s))
        .catch((e) => console.error(`refresh failed: ${e.message}`));
    }, watch * 1000);
  }
}

const HELP = `agent-mail — durable coordination for Claude Code and Codex agents

Usage: agent-mail <command> [options]

Messaging:
  notify --project <dir> --message <text> [--from <label>] [--reply-to <id>]
         [--idempotency-key <key>] [--ttl <seconds>] [--no-slack]
                        Send a message to a project's inbox
  inbox [--project <dir>] [--limit N] [--unread]
                        Read a project's spool (defaults to cwd)
  mark-read [--project <dir>] (--id <message-id> | --all)
                        Mark messages read
  receipts [--project <dir>] [--id <message-id>] [--limit N]
                        Show append-only delivery state changes
  listeners             List live sessions
  mute | unmute (--session <name-or-id> | --project <dir>)
                        Pause / resume channel push for matching sessions
  inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)
                        Set inbound treatment for matching sessions

Coordination:
  claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
                        Atomically reserve the next EXP-NNN number
  claim-path --path <path> [--directory] [--project <dir>] [--owner <label>]
                        Claim a file or directory against overlapping edits
  claims [--project <dir>]
                        List active claims
  release-claim --id <claim-id> [--project <dir>]
                        Release a claim

Dashboards:
  dashboard [--port N] [--open] [--no-tui]
                        Serve the web dashboard (press o to open, q to quit)
  slack-dashboard [--watch <seconds>]
                        Post / refresh the editable Slack dashboard

Status line:
  status-line [--project <dir>] [--session <id>] [--debug]
                        Print this session's display name when another live
                        session shares the project, nothing when alone. Reads
                        Claude Code's statusLine JSON payload on stdin.

Daemon (launchd-aware):
  start | stop | restart   Manage the daemon process
  graceful                 Reload config (SIGHUP) without a restart
  status                   Daemon health + listening sessions
  logs [-f]                Show, or follow, the daemon log

Setup:
  install [--native-audit] [--no-codex] [--replace-claude] [--replace-codex]
                        Install daemon and Claude/Codex MCP entries; optionally
                        audit native Claude SendMessage traffic
  uninstall             Remove integrations owned by this checkout

Config: ~/.config/agent-mail/config.toml  (port, Slack webhook/bot token)`;

function printHelp(stream: "out" | "err" = "out"): void {
  (stream === "err" ? console.error : console.log)(HELP);
}

// --- dispatch -------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (cmd) {
  case "notify":
    await cmdNotify(flags);
    break;
  case "inbox":
    cmdInbox(flags);
    break;
  case "mark-read":
    cmdMarkRead(flags);
    break;
  case "receipts":
    cmdReceipts(flags);
    break;
  case "listeners":
    cmdListeners();
    break;
  case "status-line":
    await cmdStatusLine(flags);
    break;
  case "mute":
    cmdSetMuted(flags, true);
    break;
  case "unmute":
    cmdSetMuted(flags, false);
    break;
  case "inbound":
    cmdSetInboundPolicy(flags);
    break;
  case "claim-experiment":
    cmdClaimExperiment(flags);
    break;
  case "claim-path":
    cmdClaimPath(flags);
    break;
  case "claims":
    cmdClaims(flags);
    break;
  case "release-claim":
    cmdReleaseClaim(flags);
    break;
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdRestart();
    break;
  case "graceful":
  case "reload":
    cmdGraceful();
    break;
  case "status":
    await cmdStatus();
    break;
  case "logs":
    cmdLogs(rest.includes("-f") || rest.includes("--follow"));
    break;
  case "dashboard":
    cmdDashboard(flags);
    break;
  case "slack-dashboard":
    await cmdSlackDashboard(flags);
    break;
  case "install":
    cmdInstall(flags);
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`agent-mail: unknown command "${cmd}"\n`);
    printHelp("err");
    process.exit(1);
}
