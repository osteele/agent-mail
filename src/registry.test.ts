import { expect, test } from "bun:test";
import { parsePsLine } from "./registry.ts";

test("parsePsLine handles macOS lstart (incl. padded day) and spaced commands", () => {
  const parsed = parsePsLine(
    "12579 Sat Aug  1 10:48:00 2026 /Users/x/.bun/bin/bun /Users/x/code/agent-tools/agent-mail/src/channel.ts",
  );
  expect(parsed?.pid).toBe(12579);
  expect(parsed?.info.start).toBe("Sat Aug 1 10:48:00 2026");
  expect(parsed?.info.command).toBe(
    "/Users/x/.bun/bin/bun /Users/x/code/agent-tools/agent-mail/src/channel.ts",
  );
});

test("parsePsLine normalizes start so recorded and current values compare", () => {
  // Same process observed twice must yield an identical start string.
  const a = parsePsLine("9198 Wed Jul 23 15:32:58 2026 /usr/sbin/distnoted");
  const b = parsePsLine("9198  Wed Jul 23 15:32:58 2026  /usr/sbin/distnoted");
  expect(a?.info.start).toBe(b?.info.start ?? "");
});

test("parsePsLine rejects blank and malformed lines", () => {
  expect(parsePsLine("")).toBeUndefined();
  expect(parsePsLine("not a ps line")).toBeUndefined();
  expect(parsePsLine("abc Sat Aug 1 10:48:00 2026 cmd")).toBeUndefined();
});
