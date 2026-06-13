#!/usr/bin/env bun
/** agent-mail CLI.
 *
 * Messaging:
 *   agent-mail notify --project <dir> --message <text> [--from <label>]
 *   agent-mail inbox [--project <dir>] [--limit N] [--unread]
 *   agent-mail mark-read [--project <dir>] (--id <message-id> | --all)
 *   agent-mail listeners
 *
 * Daemon management (launchd-aware: uses launchctl when the LaunchAgent is
 * installed, bare pidfile mode otherwise):
 *   agent-mail start | stop | restart | graceful | status | logs [-f]
 *
 * Setup:
 *   agent-mail install     LaunchAgent (boot start) + Claude mcpServers entry
 *   agent-mail uninstall
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import {
  CONFIG_PATH,
  LAUNCHD_LABEL,
  LOG_PATH,
  PID_PATH,
  canonicalProject,
  ensureDirs,
} from "./paths.ts";
import { listLive } from "./registry.ts";
import { claudeSessions } from "./sessions.ts";
import {
  knownProjects,
  markAllMessagesRead,
  markMessagesRead,
  readMessages,
} from "./spool.ts";

/** Best-effort human label for a registry entry: fresh Claude Code name, then
 * the registered snapshot, then a short session id. */
function sessionLabel(
  r: { sessionId?: string; name?: string },
  names = claudeSessions(),
): string {
  const name = (r.sessionId && names.get(r.sessionId)?.name) ?? r.name;
  if (name) return name;
  return r.sessionId ? `session ${r.sessionId.slice(0, 8)}` : "unnamed";
}

const SRC_DIR = dirname(new URL(import.meta.url).pathname);
const DAEMON_TS = join(SRC_DIR, "daemon.ts");
const CHANNEL_TS = join(SRC_DIR, "channel.ts");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const CLAUDE_JSON = join(homedir(), ".claude.json");

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
    console.log(`  ${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid})`);
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
      "usage: agent-mail notify --project <dir> --message <text> [--from <label>]",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const resolvedProject = resolveProjectArg(project);
  const body = JSON.stringify({
    project: resolvedProject,
    message,
    from: typeof flags.from === "string" ? flags.from : "cli",
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log("sent via daemon");
      return;
    }
    console.error(`daemon error: HTTP ${resp.status} ${await resp.text()}`);
    process.exit(1);
  } catch {
    // Daemon down: append directly so the message is not lost.
    const { appendMessage } = await import("./spool.ts");
    appendMessage({
      ts: new Date().toISOString(),
      from: typeof flags.from === "string" ? flags.from : "cli",
      project: resolvedProject,
      message,
    });
    console.log("daemon unreachable; spooled directly (no Slack echo)");
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
    console.log(
      `${m.id} ${m.read ? "read" : "unread"} [${m.ts}] from ${m.from}: ${m.message}`,
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

function cmdListeners(): void {
  const live = listLive();
  if (live.length === 0) {
    console.log("no sessions listening");
    return;
  }
  const names = claudeSessions();
  for (const r of live) {
    console.log(
      `${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid}, since ${r.started})`,
    );
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

function registerMcpServer(): void {
  if (!existsSync(CLAUDE_JSON)) {
    console.error(`${CLAUDE_JSON} not found; skipping mcpServers registration`);
    return;
  }
  const doc = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
    string,
    unknown
  >;
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
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

function cmdInstall(): void {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const configTemplate = [
      "# agent-mail config",
      `port = ${loadConfig().port}`,
      '# slack_webhook = "https://hooks.slack.com/services/..." (falls back to ~/.config/weft/config)',
      '# slack_echo = "all"  # or "none"',
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
  registerMcpServer();
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
    if (servers && "agent-mail" in servers) {
      const { "agent-mail": _removed, ...rest } = servers;
      doc.mcpServers = rest;
      writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
      console.log("removed agent-mail from mcpServers");
    }
  }
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
  case "listeners":
    cmdListeners();
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
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  default:
    console.log(
      "usage: agent-mail <notify|inbox|listeners|start|stop|restart|graceful|status|logs|install|uninstall>",
    );
    process.exit(cmd ? 1 : 0);
}
