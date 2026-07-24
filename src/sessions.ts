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
import { loadSessionAliases } from "./config.ts";

const SESSIONS_DIR = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "sessions",
);

export interface ClaudeSessionMeta {
  name?: string;
  status?: string;
  /** Claude Code's provenance for `name`: "derived" = auto-generated
   * `<project>-<hex>`; anything else (or a `/rename`) is a deliberate label. */
  nameSource?: string;
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
      ) as {
        sessionId?: unknown;
        name?: unknown;
        status?: unknown;
        nameSource?: unknown;
      };
      if (typeof doc.sessionId !== "string") continue;
      map.set(doc.sessionId, {
        name: typeof doc.name === "string" ? doc.name : undefined,
        status: typeof doc.status === "string" ? doc.status : undefined,
        nameSource:
          typeof doc.nameSource === "string" ? doc.nameSource : undefined,
      });
    } catch {
      // partially-written or malformed session file; skip
    }
  }
  return map;
}

/** Deterministic, pronounceable fallback used only when no project base can be
 * derived (no cwd and no name). The raw session id remains the durable address. */
export function generatedSessionName(sessionId: string): string {
  const bytes = createHash("sha256").update(sessionId).digest();
  return `${syllable(bytes, 0)}${syllable(bytes, 3)}-${syllable(bytes, 6)}${syllable(bytes, 9)}`;
}

/** One short, pronounceable syllable off the session id — the readable stand-in
 * for Claude's `-7a`/`-43` hex suffix. Low entropy is fine: a handful of
 * sessions per project. */
function readableSuffix(sessionId: string): string {
  return syllable(createHash("sha256").update(sessionId).digest(), 0);
}

/** Project base (directory basename) for a session's label, mapped through the
 * short-alias table, e.g. `llm-performance-models` -> `augur`. */
function projectBase(cwd: string, aliases: Map<string, string>): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "root";
  return aliases.get(base) ?? base;
}

let aliasCache: Map<string, string> | undefined;
/** Reload the memoized session-alias table (call after a config change). */
export function resetSessionAliasCache(): void {
  aliasCache = undefined;
}
function sessionAliases(): Map<string, string> {
  aliasCache ??= loadSessionAliases();
  return aliasCache;
}

/** Whether a Claude session name is auto-derived (`<base>-<hex>`) rather than a
 * deliberate `/rename`. Trusts `nameSource` when present; otherwise falls back
 * to the `<basename>-<2 alnum>` shape. */
function isDerivedName(
  name: string,
  nameSource: string | undefined,
  cwd?: string,
): boolean {
  if (nameSource) return nameSource === "derived";
  const base = cwd?.split("/").filter(Boolean).pop();
  return base ? new RegExp(`^${base}-[0-9a-z]{2}$`).test(name) : false;
}

/** Humanized label for a session.
 *
 * - A deliberate `/rename` (non-derived Claude name) is kept verbatim.
 * - Otherwise (Claude's auto `<base>-<hex>`, or no Claude name): a stable
 *   `<aliased-base>-<readable-suffix>` — the project stays recognizable, the
 *   suffix is pronounceable instead of hex.
 * - As a last resort (no cwd and no name) a fully generated alias is used. */
export function sessionDisplayName(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
): string {
  const name = meta?.name?.trim();
  if (name && !isDerivedName(name, meta?.nameSource, cwd)) return name;
  if (cwd)
    return `${projectBase(cwd, sessionAliases())}-${readableSuffix(sessionId)}`;
  return generatedSessionName(sessionId);
}
