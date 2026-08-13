import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_DIR, projectSlug } from "./paths.ts";
import {
  listLiveInProject,
  parsePsLine,
  register,
  scanProcesses,
  setInboundPolicy,
  setMuted,
  touchInboxPoll,
} from "./registry.ts";

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

test("a failed process inspection is distinguishable from an empty live set", () => {
  const scan = scanProcesses([process.pid], "/definitely/missing/ps");
  expect(scan.reliable).toBe(false);
  expect(scan.processes).toEqual(new Map());

  const nonconforming = scanProcesses([process.pid], "/bin/sh");
  expect(nonconforming.reliable).toBe(false);
  expect(nonconforming.processes).toEqual(new Map());

  const manyPids = Array.from({ length: 13 }, (_, index) => index + 1);
  expect(scanProcesses(manyPids, "/usr/bin/false").reliable).toBe(false);
  expect(scanProcesses(manyPids, "/usr/bin/true").reliable).toBe(false);
});

test("register does not inherit state from a recycled pid", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-register-recycled-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = register(project, process.pid, "old-session");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        cwd: project,
        pid: process.pid,
        procStart: "Mon Jan 1 00:00:00 1990",
        sessionId: "old-session",
        muted: true,
        inboundPolicy: "refuse",
        started: "1990-01-01T00:00:00.000Z",
      }),
    );

    register(project, process.pid, "new-session");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(current.sessionId).toBe("new-session");
    expect(current.procStart).not.toBe("Mon Jan 1 00:00:00 1990");
    expect(current.muted).toBeUndefined();
    expect(current.inboundPolicy).toBe("accept");
    expect(current.started).not.toBe("1990-01-01T00:00:00.000Z");
  } finally {
    if (existsSync(path)) rmSync(path);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exact process preserves session state across re-registration", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-register-same-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = register(project, process.pid, "same-session");
  try {
    expect(setMuted(project, process.pid, true)).toBe(true);
    expect(setInboundPolicy(project, process.pid, "hold")).toBe(true);
    touchInboxPoll(project, process.pid);
    const before = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;

    register(project, process.pid, "same-session", undefined, "codex");
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(after).toMatchObject({
      muted: true,
      inboundPolicy: "hold",
      lastSeen: before.lastSeen,
      lastInboxPoll: before.lastInboxPoll,
      started: before.started,
      client: "codex",
    });
  } finally {
    if (existsSync(path)) rmSync(path);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a process instance preserves state without a process-start scan", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-register-instance-"));
  const project = join(root, "project");
  mkdirSync(project);
  const instanceId = "channel-instance";
  const path = register(
    project,
    process.pid,
    "same-session",
    undefined,
    undefined,
    undefined,
    "accept",
    undefined,
    instanceId,
  );
  try {
    expect(setMuted(project, process.pid, true)).toBe(true);
    const before = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;

    register(
      project,
      process.pid,
      "same-session",
      undefined,
      "codex",
      undefined,
      "accept",
      undefined,
      instanceId,
    );
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(after).toMatchObject({
      instanceId,
      muted: true,
      started: before.started,
      client: "codex",
    });
    expect(after.procStart).toBeUndefined();
  } finally {
    if (existsSync(path)) rmSync(path);
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry mutations wait for the entry transaction lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-register-lock-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = register(project, process.pid, "locked-session");
  const lock = `${path}.lock`;
  mkdirSync(lock);
  let lockHeld = true;
  const source = join(import.meta.dir, "registry.ts");
  const script = [
    `const { setMuted } = await import(${JSON.stringify(source)});`,
    'console.log("ready");',
    "await Bun.sleep(25);",
    `console.log(setMuted(${JSON.stringify(project)}, ${process.pid}, true));`,
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    await Bun.sleep(75);
    expect(child.exitCode).toBeNull();

    rmdirSync(lock);
    lockHeld = false;
    expect(await child.exited).toBe(0);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(current.muted).toBe(true);
  } finally {
    if (lockHeld && existsSync(lock)) rmdirSync(lock);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    if (existsSync(path)) rmSync(path);
    rmSync(root, { recursive: true, force: true });
  }
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
