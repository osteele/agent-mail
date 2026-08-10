/** Shared filesystem layout for agent-mail.
 *
 * State root: ~/.claude/agent-mail/
 *   inbox/<slug>.jsonl     per-project message spools (source of truth)
 *   read/<slug>.json        per-project read message ids
 *   receipts/<slug>.jsonl  append-only delivery state changes
 *   registry/<id>.json     live channel-server registrations
 *   session-names/<id>.json persistent generated session names
 *   claims/<slug>/          experiment-number and path claims
 *   presence.json          daemon snapshot of the live registry
 *   daemon.pid, daemon.log daemon state
 * Config:     ~/.config/agent-mail/config.toml
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "agent-mail");
export const INBOX_DIR = join(STATE_DIR, "inbox");
export const READ_DIR = join(STATE_DIR, "read");
export const RECEIPTS_DIR = join(STATE_DIR, "receipts");
export const REGISTRY_DIR = join(STATE_DIR, "registry");
export const SESSION_NAMES_DIR = join(STATE_DIR, "session-names");
export const CLAIMS_DIR = join(STATE_DIR, "claims");
export const CONFIG_DIR = join(homedir(), ".config", "agent-mail");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
export const PID_PATH = join(STATE_DIR, "daemon.pid");
export const LOG_PATH = join(STATE_DIR, "daemon.log");
/** Persisted {channel, ts} of the editable Slack dashboard message. */
export const SLACK_DASHBOARD_PATH = join(STATE_DIR, "slack-dashboard.json");
/** Periodic daemon snapshot of the pid-verified live registry, so readers on a
 * latency budget can skip the process scan. */
export const PRESENCE_SNAPSHOT_PATH = join(STATE_DIR, "presence.json");

export const DEFAULT_PORT = 8377;
export const LAUNCHD_LABEL = "com.osteele.agent-mail";

export function ensureDirs(): void {
  for (const dir of [
    STATE_DIR,
    INBOX_DIR,
    READ_DIR,
    RECEIPTS_DIR,
    REGISTRY_DIR,
    SESSION_NAMES_DIR,
    CLAIMS_DIR,
    CONFIG_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Canonicalize a project path: absolute, symlinks resolved when possible. */
export function canonicalProject(project: string): string {
  const abs = resolve(project.replace(/^~(?=\/|$)/, homedir()));
  return existsSync(abs) ? realpathSync(abs) : abs;
}

/** Display name for a sender/recipient: basename of a path, else the label
 * verbatim (so "weft", "cli", or a friendly slug pass through unchanged). */
export function displayName(pathOrLabel: string): string {
  if (!pathOrLabel.includes("/")) return pathOrLabel;
  return pathOrLabel.split("/").filter(Boolean).pop() ?? pathOrLabel;
}

/** Stable spool slug for a project directory: basename + path hash. */
export function projectSlug(project: string): string {
  const canon = canonicalProject(project);
  const base = canon.split("/").filter(Boolean).pop() ?? "root";
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

export function spoolPath(project: string): string {
  return join(INBOX_DIR, `${projectSlug(project)}.jsonl`);
}

/** Append-only log of read message ids (one id per line). Append-only so
 * concurrent markers union rather than clobber each other's marks. */
export function readStatePath(project: string): string {
  return join(READ_DIR, `${projectSlug(project)}.read`);
}

export function receiptPath(project: string): string {
  return join(RECEIPTS_DIR, `${projectSlug(project)}.jsonl`);
}

/** Pre-append-only read-state file (`{read:[...]}` JSON). Read for migration so
 * existing marks survive the format change; never written anymore. */
export function legacyReadStatePath(project: string): string {
  return join(READ_DIR, `${projectSlug(project)}.json`);
}
