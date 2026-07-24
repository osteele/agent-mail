import { beforeEach, expect, test } from "bun:test";
import { resetSessionAliasCache, sessionDisplayName } from "./sessions.ts";

const SID = "1ed87600-aaaa-bbbb-cccc-000000000000";
const CWD = "/Users/x/code/mental-spaces";

beforeEach(() => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "";
  resetSessionAliasCache();
});

test("a deliberate /rename is kept verbatim", () => {
  expect(
    sessionDisplayName(SID, { name: "fix-auth-flow", nameSource: "user" }, CWD),
  ).toBe("fix-auth-flow");
});

test("a derived <base>-<hex> name becomes <base>-<readable-suffix>", () => {
  const label = sessionDisplayName(
    SID,
    { name: "mental-spaces-b4", nameSource: "derived" },
    CWD,
  );
  expect(label).toMatch(/^mental-spaces-[a-z]+$/);
  expect(label).not.toBe("mental-spaces-b4"); // hex suffix replaced
});

test("no Claude name still yields <base>-<readable-suffix>", () => {
  expect(sessionDisplayName(SID, undefined, CWD)).toMatch(
    /^mental-spaces-[a-z]+$/,
  );
});

test("absent nameSource: <base>-<2hex> shape is treated as derived", () => {
  // No nameSource, but the name matches Claude's auto pattern → transform.
  expect(sessionDisplayName(SID, { name: "mental-spaces-b4" }, CWD)).not.toBe(
    "mental-spaces-b4",
  );
  // A name that does NOT match the auto pattern is kept as a rename.
  expect(sessionDisplayName(SID, { name: "my-custom-name" }, CWD)).toBe(
    "my-custom-name",
  );
});

test("explicit non-derived nameSource overrides the auto-pattern fallback", () => {
  // Even though "mental-spaces-b4" matches the pattern, a user source keeps it.
  expect(
    sessionDisplayName(
      SID,
      { name: "mental-spaces-b4", nameSource: "user" },
      CWD,
    ),
  ).toBe("mental-spaces-b4");
});

test("the project base is mapped through the alias table", () => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "mental-spaces=ms";
  resetSessionAliasCache();
  expect(sessionDisplayName(SID, undefined, CWD)).toMatch(/^ms-[a-z]+$/);
});

test("distinct sessions in one project get distinct suffixes", () => {
  const a = sessionDisplayName("sid-aaaa", undefined, CWD);
  const b = sessionDisplayName("sid-bbbb", undefined, CWD);
  expect(a).not.toBe(b);
});
