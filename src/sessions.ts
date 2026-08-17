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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSessionAliases } from "./config.ts";
import { SESSION_NAMES_DIR } from "./paths.ts";

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
  /** Epoch ms of the session's most recent update (max of the file's
   * `updatedAt` / `statusUpdatedAt`) — the activity signal for idle times. */
  updatedAt?: number;
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

const ADJECTIVES = [
  "amber",
  "brave",
  "bright",
  "calm",
  "clear",
  "clever",
  "cool",
  "coral",
  "crisp",
  "daring",
  "deep",
  "eager",
  "fair",
  "fast",
  "gentle",
  "golden",
  "grand",
  "green",
  "happy",
  "hidden",
  "indigo",
  "jolly",
  "keen",
  "kind",
  "lively",
  "lucid",
  "lucky",
  "merry",
  "mighty",
  "nimble",
  "noble",
  "patient",
  "plain",
  "proud",
  "quick",
  "quiet",
  "rapid",
  "ready",
  "red",
  "rising",
  "royal",
  "silver",
  "small",
  "soft",
  "steady",
  "still",
  "sunny",
  "swift",
  "teal",
  "tidy",
  "true",
  "vivid",
  "warm",
  "wise",
  "witty",
  "young",
  "azure",
  "bold",
  "cosmic",
  "fresh",
  "glad",
  "open",
  "polished",
  "sharp",
] as const;

const NOUNS = [
  "badger",
  "beacon",
  "birch",
  "brook",
  "cedar",
  "comet",
  "crane",
  "dawn",
  "delta",
  "ember",
  "falcon",
  "fern",
  "finch",
  "forest",
  "fox",
  "garden",
  "grove",
  "harbor",
  "hawk",
  "heron",
  "island",
  "jay",
  "kingfisher",
  "lake",
  "lantern",
  "lark",
  "maple",
  "meadow",
  "moon",
  "oak",
  "ocean",
  "orbit",
  "otter",
  "owl",
  "pine",
  "planet",
  "quartz",
  "rain",
  "raven",
  "reef",
  "river",
  "robin",
  "sage",
  "shore",
  "sparrow",
  "star",
  "stone",
  "summit",
  "sun",
  "swift",
  "thistle",
  "tiger",
  "trail",
  "vale",
  "willow",
  "wind",
  "wren",
  "acorn",
  "bridge",
  "cloud",
  "field",
  "glade",
  "kestrel",
  "wave",
] as const;

export interface GeneratedSessionName {
  scheme: "legacy-syllable" | "adjective-noun";
  slug: string;
  displayName: string;
}

export interface SessionNames {
  /** Stable address shown in global lists and accepted by --session. */
  fullName: string;
  /** Human-facing name used where the project is already evident. */
  displayName: string;
  generated: boolean;
}

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
        updatedAt?: unknown;
        statusUpdatedAt?: unknown;
      };
      if (typeof doc.sessionId !== "string") continue;
      const stamps = [doc.updatedAt, doc.statusUpdatedAt].filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v),
      );
      map.set(doc.sessionId, {
        name: typeof doc.name === "string" ? doc.name : undefined,
        status: typeof doc.status === "string" ? doc.status : undefined,
        nameSource:
          typeof doc.nameSource === "string" ? doc.nameSource : undefined,
        updatedAt: stamps.length ? Math.max(...stamps) : undefined,
      });
    } catch {
      // partially-written or malformed session file; skip
    }
  }
  return map;
}

/** One short, pronounceable syllable off the session id — the readable stand-in
 * for Claude's `-7a`/`-43` hex suffix. Low entropy is fine: a handful of
 * sessions per project. */
function readableSuffix(sessionId: string): string {
  return syllable(createHash("sha256").update(sessionId).digest(), 0);
}

export function legacyGeneratedSessionName(
  sessionId: string,
): GeneratedSessionName {
  const slug = readableSuffix(sessionId);
  return { scheme: "legacy-syllable", slug, displayName: slug };
}

export function adjectiveNounSessionName(
  sessionId: string,
): GeneratedSessionName {
  const bytes = createHash("sha256").update(sessionId).digest();
  const adjective = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  return {
    scheme: "adjective-noun",
    slug: `${adjective}-${noun}`,
    displayName: `${adjective[0].toUpperCase()}${adjective.slice(1)} ${noun[0].toUpperCase()}${noun.slice(1)}`,
  };
}

function assignmentPath(sessionId: string, directory: string): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${id}.json`);
}

function readGeneratedSessionName(
  sessionId: string,
  directory: string,
): GeneratedSessionName | undefined {
  const path = assignmentPath(sessionId, directory);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as GeneratedSessionName;
  if (
    (value.scheme !== "legacy-syllable" && value.scheme !== "adjective-noun") ||
    typeof value.slug !== "string" ||
    typeof value.displayName !== "string"
  ) {
    throw new Error(`invalid session-name assignment: ${path}`);
  }
  return {
    scheme: value.scheme,
    slug: value.slug,
    displayName: value.displayName,
  };
}

/** Return the session's persisted generated name, selecting one only once.
 * `legacy` is used by the upgrade migration for sessions that were already
 * registered; all genuinely new session ids use adjective–noun names. */
export function assignedGeneratedSessionName(
  sessionId: string,
  legacy = false,
  directory = SESSION_NAMES_DIR,
): GeneratedSessionName {
  const existing = readGeneratedSessionName(sessionId, directory);
  if (existing) return existing;
  const selected = legacy
    ? legacyGeneratedSessionName(sessionId)
    : adjectiveNounSessionName(sessionId);
  mkdirSync(directory, { recursive: true });
  const path = assignmentPath(sessionId, directory);
  try {
    writeFileSync(path, JSON.stringify({ sessionId, ...selected }, null, 1), {
      flag: "wx",
    });
    return selected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readGeneratedSessionName(sessionId, directory);
    if (!raced) throw error;
    return raced;
  }
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

/** Full and display names for a session.
 *
 * - A deliberate `/rename` (non-derived Claude name) is kept verbatim.
 * - Otherwise the persisted generated name supplies a kebab-case slug for the
 *   full name and a human-facing display name.
 * - The full name includes the aliased project base when cwd is available. */
export function sessionNames(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): SessionNames {
  const name = meta?.name?.trim();
  if (name && !isDerivedName(name, meta?.nameSource, cwd)) {
    return { fullName: name, displayName: name, generated: false };
  }
  const generated =
    generatedName ?? assignedGeneratedSessionName(sessionId, false);
  return {
    fullName: cwd
      ? `${projectBase(cwd, sessionAliases())}-${generated.slug}`
      : generated.slug,
    displayName: generated.displayName,
    generated: true,
  };
}

/** Stable address: `<project>-<adjective>-<noun>` for new generated names. */
export function sessionFullName(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): string {
  return sessionNames(sessionId, meta, cwd, generatedName).fullName;
}

/** Human-facing name used in routes and other project-labelled contexts. */
export function sessionDisplayName(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): string {
  return sessionNames(sessionId, meta, cwd, generatedName).displayName;
}

// --- Session identity from the environment -----------------------------------

/** Env vars that carry a per-session agent id, in resolution order.
 *
 * Native ids come first: an agent that mints its own per-session id knows more
 * than a launcher wrapping it does. `AGENT_SESSION_ID` is the generic fallback
 * for agents that export nothing of their own (kimi and opencode export only
 * process-level or workspace-level ids, neither of which separates two sessions
 * in one directory). The guard launcher mints it and unsets the native ids
 * first, so a nested agent cannot be mistaken for the parent that launched it —
 * plain inheritance would otherwise hand a nested kimi its parent's
 * CLAUDE_CODE_SESSION_ID. */
export const SESSION_ID_ENV_VARS = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "AGENT_SESSION_ID",
] as const;

/** Resolve the calling agent's session id from the environment.
 *
 * Empty values are skipped rather than winning the chain: an `export X=""`
 * upstream would otherwise mask a real id further down it. */
export function sessionIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const name of SESSION_ID_ENV_VARS) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** The subset of a session's identity that `--session` can be matched against. */
export interface SessionAddress {
  sessionId: string;
  fullName: string;
  displayName: string;
}

/** Sessions a `--session` argument names: exact id, exact full name, or
 * case-insensitive display name. Returning every match lets each caller decide
 * what an ambiguous name means — send_mail refuses, notify broadcasts. */
export function matchSessions<T extends SessionAddress>(
  candidates: T[],
  query: string,
): T[] {
  const normalized = query.toLocaleLowerCase();
  return candidates.filter(
    (c) =>
      c.sessionId === query ||
      c.fullName === query ||
      c.displayName.toLocaleLowerCase() === normalized,
  );
}

export type SessionQueryResult<T> =
  | { kind: "unique"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: T[] };

/** `matchSessions` reduced to the three cases callers actually branch on.
 *
 * Whether "none" and "ambiguous" are errors is the caller's policy, not this
 * function's: an agent calling send_mail is present to read an error and retry,
 * while an automation reporting a finished job is not, and refusing there would
 * discard the message. */
export function resolveSessionQuery<T extends SessionAddress>(
  candidates: T[],
  query: string,
): SessionQueryResult<T> {
  const matches = matchSessions(candidates, query);
  if (matches.length === 1) return { kind: "unique", session: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}

// --- Session recency ---------------------------------------------------------
//
// "Attached" (channel server alive, will receive push) and "present" (the agent
// has done anything recently) diverge exactly when a session sits idle for a
// long time — which misleads peers into overcounting active agents. These
// helpers turn the available signals into an idle-time tag every surface shows.

/** Most recent sign of life, epoch ms: Claude's session-meta update time, the
 * registry `lastSeen` (stamped on tool calls), or the registration time. */
export function lastActivityMs(
  reg: { started: string; lastSeen?: string },
  meta?: ClaudeSessionMeta,
): number {
  const candidates = [
    Date.parse(reg.started),
    reg.lastSeen ? Date.parse(reg.lastSeen) : Number.NaN,
    meta?.updatedAt ?? Number.NaN,
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

/** Compact age: "<1m", "12m", "26h", "3d". Hours run to 47h so day-old
 * sessions still read in hours. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const ACTIVE_MS = 2 * 60_000;
const STALE_MS = 24 * 3600_000;

/** Presence tag: "busy" (Claude reports it mid-turn), "active" (signs of life
 * within the last two minutes), else "idle <age>" — flagged "stale?" once
 * nothing has happened for a day, so peers discount attached-but-vacant
 * sessions instead of counting them as active agents. */
export function activityTag(
  status: string | undefined,
  lastActiveMs: number,
  nowMs = Date.now(),
): string {
  if (status === "busy") return "busy";
  const age = nowMs - lastActiveMs;
  if (age < ACTIVE_MS) return "active";
  const tag = `idle ${formatAge(age)}`;
  return isStaleSession(status, lastActiveMs, nowMs) ? `${tag} — stale?` : tag;
}

/** Whether a session has shown no sign of life for long enough that peers
 * should discount it rather than count it as another working agent. Shares one
 * threshold and one precedence rule with `activityTag` (a session Claude
 * reports as mid-turn is never stale), so callers can ask the question directly
 * instead of matching "stale?" against a rendered tag. */
export function isStaleSession(
  status: string | undefined,
  lastActiveMs: number,
  nowMs = Date.now(),
): boolean {
  if (status === "busy") return false;
  return nowMs - lastActiveMs >= STALE_MS;
}
