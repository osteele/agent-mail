import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_DIR, projectSlug } from "./paths.ts";
import { listLiveInProject, parsePsLine } from "./registry.ts";

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

test("listLiveInProject collapses legacy and canonical spellings of one dir", () => {
  // A directory move leaves entries under the pre-move path. Both spellings
  // name one project, so a scoped read must return both — comparing raw `cwd`
  // strings would silently split the project in two.
  const pid = process.pid;
  const ps = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "pid=,lstart=,command="],
    { encoding: "utf8" },
  );
  const procStart = parsePsLine((ps.stdout ?? "").split("\n")[0])?.info.start;
  expect(procStart).toBeTruthy();

  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-mail-registry-")),
  );
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);

  const written: string[] = [];
  try {
    for (const [cwd, sessionId] of [
      [real, "canonical"],
      [link, "legacy"],
    ]) {
      // Distinct filenames on purpose. `projectSlug` canonicalizes, so both
      // spellings hash to one slug and would collide on a single file — but a
      // pre-move entry was written under the old path's slug, and the reader
      // matches on the entry's `cwd` field rather than on its filename.
      const path = join(REGISTRY_DIR, `${projectSlug(cwd)}-${sessionId}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          cwd,
          pid,
          procStart,
          sessionId,
          started: new Date().toISOString(),
        }),
      );
      written.push(path);
    }
    const live = listLiveInProject(real);
    expect(live.map((r) => r.sessionId).sort()).toEqual([
      "canonical",
      "legacy",
    ]);
    // Entries belonging to other projects are never inspected, so nothing else
    // in the shared registry is disturbed.
    expect(listLiveInProject(join(root, "absent"))).toEqual([]);
  } finally {
    for (const path of written) if (existsSync(path)) rmSync(path);
    rmSync(root, { recursive: true, force: true });
  }
});
