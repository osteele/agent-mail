/** Claude Code per-session metadata (~/.claude/sessions/<pid>.json).
 *
 * Undocumented Claude Code internal state: each interactive session writes a
 * file mapping {sessionId, cwd, name, status, ...}. We read it only to attach a
 * human-readable name (set via `/rename`) to a sessionId. Read defensively —
 * the format may change between Claude Code versions, or be absent on older
 * ones, in which case names are simply unavailable and callers use a
 * generated alias.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "sessions",
);

export interface ClaudeSessionMeta {
  name?: string;
  status?: string;
}

const ONSETS = [
  "b",
  "br",
  "d",
  "f",
  "fl",
  "g",
  "h",
  "j",
  "k",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "v",
  "w",
  "z",
];
const VOWELS = ["a", "e", "i", "o", "u", "ai", "ia"];
const CODAS = ["", "", "", "l", "m", "n", "r", "s"];

function syllable(bytes: Buffer, offset: number): string {
  return (
    ONSETS[bytes[offset] % ONSETS.length] +
    VOWELS[bytes[offset + 1] % VOWELS.length] +
    CODAS[bytes[offset + 2] % CODAS.length]
  );
}

/** Map of sessionId -> {name, status} for every recorded Claude Code session.
 *
 * Files are keyed by the Claude Code REPL pid, not the sessionId, so we read
 * each file and index by its `sessionId` field. Live-ness is not checked here;
 * cross-reference the agent-mail registry (which is pid-pruned) for that. */
export function claudeSessions(): Map<string, ClaudeSessionMeta> {
  const map = new Map<string, ClaudeSessionMeta>();
  if (!existsSync(SESSIONS_DIR)) return map;
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), "utf8"),
      ) as { sessionId?: unknown; name?: unknown; status?: unknown };
      if (typeof doc.sessionId !== "string") continue;
      map.set(doc.sessionId, {
        name: typeof doc.name === "string" ? doc.name : undefined,
        status: typeof doc.status === "string" ? doc.status : undefined,
      });
    } catch {
      // partially-written or malformed session file; skip
    }
  }
  return map;
}

/** Human-readable name for a sessionId, if Claude Code recorded one. */
export function sessionName(sessionId: string): string | undefined {
  return claudeSessions().get(sessionId)?.name;
}

/** Deterministic, pronounceable fallback for sessions without a `/rename`.
 *
 * The raw session id remains the durable address; this is just a compact alias
 * for humans and dashboards. */
export function generatedSessionName(sessionId: string): string {
  const bytes = createHash("sha256").update(sessionId).digest();
  return `${syllable(bytes, 0)}${syllable(bytes, 3)}-${syllable(bytes, 6)}${syllable(bytes, 9)}`;
}

/** Prefer an explicit Claude Code `/rename`; otherwise use the generated alias. */
export function sessionDisplayName(
  sessionId: string,
  explicitName?: string,
): string {
  const name = explicitName?.trim();
  return name || generatedSessionName(sessionId);
}
