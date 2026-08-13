import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("notify --no-slack suppresses only that message's Slack echo", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return Response.json({ ok: true, status: "spooled", id: "test" });
    },
  });
  const project = mkdtempSync(join(tmpdir(), "agent-mail-cli-test-"));
  const cli = join(import.meta.dir, "cli.ts");

  try {
    for (const extra of [[], ["--no-slack"]]) {
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          "notify",
          "--project",
          project,
          "--message",
          "test message",
          ...extra,
        ],
        {
          env: { ...process.env, AGENT_MAIL_PORT: String(server.port) },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
    }
  } finally {
    server.stop(true);
    rmSync(project, { recursive: true });
  }

  expect(requests).toHaveLength(2);
  expect(requests[0].slackEcho).toBeUndefined();
  expect(requests[1].slackEcho).toBe(false);
});

test("status-line prints nothing and exits 0 when the session is alone", async () => {
  // The consumer is a shell substitution inside a status-line script, so a
  // non-zero exit is hazardous under `set -e` and stray output corrupts the
  // user's prompt. Empty output is the signal for "nothing to show".
  const project = mkdtempSync(join(tmpdir(), "agent-mail-statusline-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const child = Bun.spawn(
      [process.execPath, cli, "status-line", "--project", project],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
  } finally {
    rmSync(project, { recursive: true });
  }
});

test("listeners --no-sync emits snapshot JSON without pruning registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-listeners-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(home, ".claude", "agent-mail");
  const registry = join(data, "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const untouched = join(registry, "invalid.json");
  writeFileSync(untouched, "not a registration");
  writeFileSync(
    join(data, "presence.json"),
    JSON.stringify({
      version: 1,
      generatedAt: Date.now(),
      generatedBy: process.pid,
      sessions: [
        {
          cwd: project,
          pid: process.pid,
          sessionId: "poller",
          capabilities: { inboxPoll: true, channelPush: false },
          lastInboxPoll: "2026-08-12T12:00:00.000Z",
          started: "2026-08-12T11:00:00.000Z",
        },
      ],
    }),
  );
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "listeners",
        "--project",
        project,
        "--no-sync",
        "--json",
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    const report = JSON.parse(
      await new Response(child.stdout).text(),
    ) as Record<string, unknown>;
    expect(report.source).toBe("presence-snapshot");
    expect(report.fresh).toBe(true);
    expect(report.sessions).toHaveLength(1);
    expect(existsSync(untouched)).toBe(true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("claim-path groups repeated path flags under one claim id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-claims-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const claim = Bun.spawn(
      [
        process.execPath,
        cli,
        "claim-path",
        "--project",
        project,
        "--path",
        "one.swift",
        "--path",
        "two.swift",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await claim.exited).toBe(0);
    const output = await new Response(claim.stdout).text();
    const claimId = output.split("\n")[0];
    expect(claimId).toMatch(/^[0-9a-f-]+$/);
    expect(output).toContain("file ");
    expect(output).toContain("one.swift");
    expect(output).toContain("two.swift");

    const list = Bun.spawn(
      [process.execPath, cli, "claims", "--project", project],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await list.exited).toBe(0);
    const listed = await new Response(list.stdout).text();
    expect(listed.trim().split("\n")).toHaveLength(1);
    expect(listed).toContain("one.swift");
    expect(listed).toContain("two.swift");

    const release = Bun.spawn(
      [
        process.execPath,
        cli,
        "release-claim",
        "--project",
        project,
        "--id",
        claimId,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await release.exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("work CLI lists logical ownership across projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-work-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const acquire = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "research-plan",
        "--key",
        "2026-08-12-pilot",
        "--owner",
        "operator",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquire.exited).toBe(0);
    const acquired = await new Response(acquire.stdout).text();
    const workId = acquired.split(" ")[0];
    expect(workId).toMatch(/^[0-9a-f-]+$/);

    const list = Bun.spawn([process.execPath, cli, "work", "list", "--all"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await list.exited).toBe(0);
    expect(await new Response(list.stdout).text()).toContain(
      "research-plan:2026-08-12-pilot",
    );

    const release = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "release",
        "--project",
        project,
        "--id",
        workId,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await release.exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true });
  }
});
