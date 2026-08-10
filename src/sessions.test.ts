import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityTag,
  adjectiveNounSessionName,
  assignedGeneratedSessionName,
  formatAge,
  isStaleSession,
  lastActivityMs,
  legacyGeneratedSessionName,
  resetSessionAliasCache,
  sessionDisplayName,
  sessionFullName,
  sessionNames,
} from "./sessions.ts";

const SID = "1ed87600-aaaa-bbbb-cccc-000000000000";
const CWD = "/Users/x/code/mental-spaces";
const LEGACY = legacyGeneratedSessionName(SID);

beforeEach(() => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "";
  resetSessionAliasCache();
});

test("a deliberate /rename is kept verbatim", () => {
  expect(
    sessionFullName(SID, { name: "fix-auth-flow", nameSource: "user" }, CWD),
  ).toBe("fix-auth-flow");
});

test("a derived <base>-<hex> name becomes <base>-<readable-suffix>", () => {
  const label = sessionFullName(
    SID,
    { name: "mental-spaces-b4", nameSource: "derived" },
    CWD,
    LEGACY,
  );
  expect(label).toMatch(/^mental-spaces-[a-z]+$/);
  expect(label).not.toBe("mental-spaces-b4"); // hex suffix replaced
});

test("no Claude name still yields <base>-<readable-suffix>", () => {
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toMatch(
    /^mental-spaces-[a-z]+$/,
  );
});

test("absent nameSource: <base>-<2hex> shape is treated as derived", () => {
  // No nameSource, but the name matches Claude's auto pattern → transform.
  expect(
    sessionFullName(SID, { name: "mental-spaces-b4" }, CWD, LEGACY),
  ).not.toBe("mental-spaces-b4");
  // A name that does NOT match the auto pattern is kept as a rename.
  expect(sessionFullName(SID, { name: "my-custom-name" }, CWD)).toBe(
    "my-custom-name",
  );
});

test("explicit non-derived nameSource overrides the auto-pattern fallback", () => {
  // Even though "mental-spaces-b4" matches the pattern, a user source keeps it.
  expect(
    sessionFullName(SID, { name: "mental-spaces-b4", nameSource: "user" }, CWD),
  ).toBe("mental-spaces-b4");
});

test("the project base is mapped through the alias table", () => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "mental-spaces=ms";
  resetSessionAliasCache();
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toMatch(/^ms-[a-z]+$/);
});

test("distinct sessions in one project get distinct suffixes", () => {
  const a = sessionFullName(
    "sid-aaaa",
    undefined,
    CWD,
    legacyGeneratedSessionName("sid-aaaa"),
  );
  const b = sessionFullName(
    "sid-bbbb",
    undefined,
    CWD,
    legacyGeneratedSessionName("sid-bbbb"),
  );
  expect(a).not.toBe(b);
});

test("legacy display names keep the current compact label", () => {
  const generated = sessionDisplayName(
    SID,
    { name: "mental-spaces-b4", nameSource: "derived" },
    CWD,
    LEGACY,
  );
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toBe(
    `mental-spaces-${generated}`,
  );
  expect(
    sessionDisplayName(SID, { name: "fix-auth-flow", nameSource: "user" }, CWD),
  ).toBe("fix-auth-flow");
});

test("new sessions get adjective-noun full and display names", () => {
  const generated = adjectiveNounSessionName(SID);
  const names = sessionNames(SID, undefined, CWD, generated);
  expect(names.fullName).toMatch(/^mental-spaces-[a-z]+-[a-z]+$/);
  expect(names.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect(names.fullName.endsWith(generated.slug)).toBe(true);
  expect(names.displayName).toBe(generated.displayName);
});

test("a persisted selection wins over a later requested scheme", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  try {
    const legacy = assignedGeneratedSessionName(SID, true, directory);
    expect(assignedGeneratedSessionName(SID, false, directory)).toEqual(legacy);
    const [file] = readdirSync(directory);
    const stored = readFileSync(join(directory, file), "utf8");
    expect(stored).toContain('"scheme": "legacy-syllable"');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

// --- recency helpers ---------------------------------------------------------

test("formatAge buckets: minutes, hours to 47h, then days", () => {
  expect(formatAge(30_000)).toBe("<1m");
  expect(formatAge(12 * 60_000)).toBe("12m");
  expect(formatAge(26 * 3600_000)).toBe("26h"); // day-old still reads in hours
  expect(formatAge(49 * 3600_000)).toBe("2d");
});

test("lastActivityMs takes the most recent of started/lastSeen/meta", () => {
  const started = "2026-08-01T00:00:00.000Z";
  const lastSeen = "2026-08-01T12:00:00.000Z";
  const metaMs = Date.parse("2026-08-01T18:00:00.000Z");
  expect(lastActivityMs({ started })).toBe(Date.parse(started));
  expect(lastActivityMs({ started, lastSeen })).toBe(Date.parse(lastSeen));
  expect(lastActivityMs({ started, lastSeen }, { updatedAt: metaMs })).toBe(
    metaMs,
  );
});

test("activityTag: busy wins; recent is active; old idle is flagged stale", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  expect(activityTag("busy", now - 26 * 3600_000, now)).toBe("busy");
  expect(activityTag(undefined, now - 30_000, now)).toBe("active");
  expect(activityTag("idle", now - 3 * 3600_000, now)).toBe("idle 3h");
  expect(activityTag("idle", now - 26 * 3600_000, now)).toBe(
    "idle 26h — stale?",
  );
});

test("isStaleSession agrees with the tag activityTag renders", () => {
  // The gate asks the predicate directly instead of matching "stale?" against a
  // rendered string; this pins the two to one threshold and one precedence rule.
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const ages = [
    0,
    60_000,
    3600_000,
    23 * 3600_000,
    24 * 3600_000,
    72 * 3600_000,
  ];
  for (const status of [undefined, "busy", "idle"]) {
    for (const age of ages) {
      const lastActive = now - age;
      expect(isStaleSession(status, lastActive, now)).toBe(
        activityTag(status, lastActive, now).endsWith("stale?"),
      );
    }
  }
});
