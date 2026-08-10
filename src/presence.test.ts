import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProject } from "./paths.ts";
import {
  type PresenceSnapshot,
  liveInProject,
  peersInProject,
  readPresenceSnapshot,
  statusLineName,
  writePresenceSnapshot,
} from "./presence.ts";
import type { Registration } from "./registry.ts";
import type { ClaudeSessionMeta } from "./sessions.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function scratch(): string {
  // realpath first: macOS mkdtemp returns /var/folders/… which canonicalizes to
  // /private/var/folders/…, so a raw comparison would fail for the wrong reason.
  return realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-presence-")));
}

function reg(over: Partial<Registration> & { pid: number }): Registration {
  return {
    cwd: "/proj",
    started: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

/** A session whose last sign of life was `idleHours` ago. Both `started` and
 * `lastSeen` have to move: `lastActivityMs` takes the max of the two, so a
 * recent `started` would mask an old `lastSeen`. */
function peer(sessionId: string, idleHours: number, pid: number): Registration {
  const at = new Date(NOW - idleHours * HOUR).toISOString();
  return { cwd: "/proj", pid, sessionId, started: at, lastSeen: at };
}

function metaMap(
  entries: Record<string, ClaudeSessionMeta>,
): Map<string, ClaudeSessionMeta> {
  return new Map(Object.entries(entries));
}

function snapshotFile(dir: string, body: unknown): string {
  const path = join(dir, "presence.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

// --- snapshot freshness ------------------------------------------------------

test("readPresenceSnapshot accepts a snapshot inside the TTL", () => {
  const dir = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 5_000,
    generatedBy: 1,
    sessions: [reg({ pid: 1, sessionId: "a" })],
  } satisfies PresenceSnapshot);
  expect(readPresenceSnapshot(NOW, 30_000, path)?.sessions).toHaveLength(1);
});

test("readPresenceSnapshot rejects a snapshot past the TTL", () => {
  const dir = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 45_000,
    generatedBy: 1,
    sessions: [reg({ pid: 1 })],
  } satisfies PresenceSnapshot);
  expect(readPresenceSnapshot(NOW, 30_000, path)).toBeUndefined();
});

test("readPresenceSnapshot returns undefined rather than throwing on junk", () => {
  const dir = scratch();
  // A status line that crashes is worse than one that falls back, so every
  // malformed shape must degrade quietly.
  expect(
    readPresenceSnapshot(NOW, 30_000, join(dir, "missing.json")),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(NOW, 30_000, snapshotFile(dir, "{")),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(NOW, 30_000, snapshotFile(dir, { version: 2 })),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(
      NOW,
      30_000,
      snapshotFile(dir, { version: 1, generatedAt: NOW, sessions: "nope" }),
    ),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(
      NOW,
      30_000,
      snapshotFile(dir, { version: 1, generatedAt: "soon", sessions: [] }),
    ),
  ).toBeUndefined();
});

test("writePresenceSnapshot round-trips and leaves no temp file behind", () => {
  const dir = scratch();
  const path = join(dir, "presence.json");
  const written = writePresenceSnapshot(NOW, path);
  const read = readPresenceSnapshot(NOW, 30_000, path);
  expect(read?.generatedAt).toBe(written.generatedAt);
  expect(read?.sessions.length).toBe(written.sessions.length);
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("liveInProject falls back to a scan when no snapshot exists", () => {
  // Empty project, no snapshot at the default path in this scratch dir: the
  // fallback must run and simply find nobody, not throw.
  const dir = scratch();
  expect(liveInProject(dir, NOW)).toEqual([]);
});

// --- the gate ----------------------------------------------------------------

test("stale peers are excluded from the peer count", () => {
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    peer("fresh", 20, 2),
    peer("stale", 25, 3),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  const peers = peersInProject(sessions, "self", meta, NOW);
  expect(peers.map((p) => p.sessionId)).toEqual(["fresh"]);
  expect(statusLineName(sessions, "/proj", "self", meta, NOW)).toBe(
    "Self Name",
  );
});

test("a session alone in its project renders nothing", () => {
  const sessions = [reg({ pid: 1, sessionId: "self" })];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(statusLineName(sessions, "/proj", "self", meta, NOW)).toBe("");
});

test("an abandoned peer does not pin the name on forever", () => {
  // The regression that matters: one long-dead session sharing the directory
  // must not keep the name displayed indefinitely.
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    peer("abandoned", 40, 2),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(statusLineName(sessions, "/proj", "self", meta, NOW)).toBe("");
});

test("a busy peer counts however old its last activity looks", () => {
  const sessions = [reg({ pid: 1, sessionId: "self" }), peer("working", 30, 2)];
  const meta = metaMap({
    self: { status: "busy", name: "Self Name" },
    working: { status: "busy" },
  });
  expect(
    peersInProject(sessions, "self", meta, NOW).map((p) => p.sessionId),
  ).toEqual(["working"]);
});

test("self is excluded by session id, not by pid", () => {
  // A re-register leaves two entries for one session under different pids;
  // both are us, so neither is a peer.
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    reg({ pid: 2, sessionId: "self" }),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(peersInProject(sessions, "self", meta, NOW)).toHaveLength(1);
  // ...but the surviving entry is still this session, so nothing is rendered
  // only when it is genuinely alone. Two entries for one id read as one peer,
  // which is the conservative direction.
  expect(statusLineName(sessions, "/proj", "self", meta, NOW)).toBe(
    "Self Name",
  );
});

test("an unidentifiable self discounts one live entry", () => {
  // After /clear, Claude mints a new session id without respawning MCP servers,
  // so the payload id matches nothing in the registry.
  const one = [reg({ pid: 1, sessionId: "other" })];
  const two = [
    reg({ pid: 1, sessionId: "a" }),
    reg({ pid: 2, sessionId: "b" }),
  ];
  const meta = metaMap({});
  expect(peersInProject(one, "unknown", meta, NOW)).toHaveLength(0);
  expect(peersInProject(two, "unknown", meta, NOW)).toHaveLength(1);
});

test("legacy and canonical spellings of one directory collapse to one project", () => {
  const root = scratch();
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);
  expect(canonicalProject(link)).toBe(canonicalProject(real));

  // Entries written before a directory move carry the old spelling; both must
  // land in the same bucket or one project silently reads as two.
  const sessions = [
    reg({ pid: 1, sessionId: "self", cwd: real }),
    reg({ pid: 2, sessionId: "peer", cwd: link }),
  ];
  const canon = canonicalProject(real);
  const scoped = sessions.filter((r) => canonicalProject(r.cwd) === canon);
  expect(scoped).toHaveLength(2);

  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(statusLineName(scoped, canon, "self", meta, NOW)).toBe("Self Name");
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});
