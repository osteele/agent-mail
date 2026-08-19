import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.ts";
import { processInfo } from "./registry.ts";

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

test("status-line prints nothing and exits 0 with no session to name", async () => {
  // The consumer is a shell substitution inside a status-line script, so a
  // non-zero exit is hazardous under `set -e` and stray output corrupts the
  // user's prompt. Empty output is the signal for "nothing to show" — which
  // now means only that no session id could be resolved. Being alone in the
  // project is not that: the name is this session's address elsewhere, so it
  // prints whether or not anyone is standing nearby.
  const project = mkdtempSync(join(tmpdir(), "agent-mail-statusline-"));
  const cli = join(import.meta.dir, "cli.ts");
  // The environment carries this very session's id; inheriting it would have
  // the test name the agent running it.
  const env = { ...process.env };
  for (const key of [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "AGENT_SESSION_ID",
  ]) {
    delete env[key];
  }
  try {
    const child = Bun.spawn(
      [process.execPath, cli, "status-line", "--project", project],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");

    const named = Bun.spawn(
      [
        process.execPath,
        cli,
        "status-line",
        "--project",
        project,
        "--session",
        "solitary-session",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );
    named.stdin.end();
    expect(await named.exited).toBe(0);
    expect((await new Response(named.stdout).text()).trim()).not.toBe("");
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

test("state --no-sync emits versioned aggregate data without pruning", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-state-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(home, ".claude", "agent-mail");
  const registry = join(data, "registry");
  const inbox = join(data, "inbox");
  mkdirSync(project, { recursive: true });
  const canonical = realpathSync(project);
  mkdirSync(registry, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const untouched = join(registry, "invalid.json");
  writeFileSync(untouched, "not a registration");
  const now = Date.now();
  writeFileSync(
    join(data, "presence.json"),
    JSON.stringify({
      version: 1,
      generatedAt: now,
      generatedBy: process.pid,
      sessions: [],
    }),
  );
  writeFileSync(
    join(data, "processes.json"),
    JSON.stringify({
      version: 1,
      generatedAt: now,
      generatedBy: process.pid,
      pids: [],
      reliable: true,
      processes: [],
    }),
  );
  writeFileSync(
    join(inbox, `${projectSlug(project)}.jsonl`),
    `${JSON.stringify({
      ts: "2026-08-13T12:00:00.000Z",
      from: "sender",
      project: canonical,
      message: "legacy id",
    })}\n`,
  );
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "state",
        "--project",
        project,
        "--no-sync",
        "--json",
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await new Response(child.stdout).text()) as {
      schemaVersion: number;
      source: { mode: string };
      freshness: { presence: boolean };
      messages: Array<{ id: string; read: boolean }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.source.mode).toBe("filesystem-snapshot");
    expect(report.freshness.presence).toBe(true);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(report.messages[0].read).toBe(false);
    expect(existsSync(untouched)).toBe(true);
    expect(existsSync(join(data, "claims"))).toBe(false);
    expect(existsSync(join(data, "work"))).toBe(false);
    expect(existsSync(join(data, "transfers"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
        "--owner",
        "operator",
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

test("unregistered coordination acquisition requires a manual owner label", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-owner-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    ...base
  } = process.env;
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "work",
      "acquire",
      "--project",
      project,
      "--type",
      "task",
      "--key",
      "one",
    ],
    {
      env: { ...base, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "requires --owner <label>",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("work conflicts explain manual ownership and the recovery path", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-conflict-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const first = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "task",
        "--key",
        "one",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await first.exited).toBe(0);
    const second = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "task",
        "--key",
        "one",
        "--owner",
        "requester",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await second.exited).not.toBe(0);
    expect(await new Response(second.stderr).text()).toContain(
      "owner is deliberately manual",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work transfer CLI records and accepts an auditable handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-transfer-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const acquired = Bun.spawn(
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
        "plan",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquired.exited).toBe(0);
    const workId = (await new Response(acquired.stdout).text()).split(" ")[0];

    const requested = Bun.spawn(
      [
        process.execPath,
        cli,
        "coordination",
        "request-transfer",
        "--id",
        workId,
        "--owner",
        "requester",
        "--timeout",
        "60",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await requested.exited).toBe(0);
    const request = JSON.parse(await new Response(requested.stdout).text()) as {
      id: string;
      status: string;
      requestNotifiedAt?: string;
    };
    expect(request.status).toBe("requested");

    const accepted = Bun.spawn(
      [
        process.execPath,
        cli,
        "coordination",
        "respond-transfer",
        "--id",
        request.id,
        "--decision",
        "accept",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await accepted.exited).toBe(0);
    const response = JSON.parse(await new Response(accepted.stdout).text()) as {
      status: string;
      actualOwner?: { label: string };
    };
    expect(response.status).toBe("accepted");
    expect(response.actualOwner?.label).toBe("requester");

    const transferFiles = readdirSync(
      join(home, ".claude", "agent-mail", "transfers"),
    ).filter((name) => name.endsWith(".json"));
    expect(transferFiles).toHaveLength(1);
    const stored = JSON.parse(
      readFileSync(
        join(home, ".claude", "agent-mail", "transfers", transferFiles[0]),
        "utf8",
      ),
    ) as { requestNotifiedAt?: string; resolutionNotifiedAt?: string };
    expect(stored.requestNotifiedAt).toBeDefined();
    expect(stored.resolutionNotifiedAt).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work CLI attaches ownership to its registered Codex session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-session-work-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(home, ".claude", "agent-mail");
  const registry = join(state, "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  expect(procStart).toBeTruthy();
  writeFileSync(
    join(registry, `${projectSlug(project)}-${process.pid}.json`),
    JSON.stringify({
      cwd: project,
      pid: process.pid,
      procStart,
      sessionId: "codex-session",
      client: "codex",
      started: new Date().toISOString(),
    }),
  );
  const cli = join(import.meta.dir, "cli.ts");
  const { CLAUDE_CODE_SESSION_ID: _claudeSessionId, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    HOME: home,
    CODEX_THREAD_ID: "codex-session",
  };
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
        "session-plan",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquire.exited).toBe(0);
    const workDir = join(state, "work", projectSlug(project));
    const files = readdirSync(workDir);
    expect(files).toHaveLength(1);
    const lease = JSON.parse(readFileSync(join(workDir, files[0]), "utf8")) as {
      owner: Record<string, unknown>;
    };
    expect(lease.owner).toMatchObject({
      id: "codex-session",
      sessionId: "codex-session",
      pid: process.pid,
      procStart,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Spawn `notify` against a stub daemon and return the JSON it received. */
async function notifyRequest(
  args: string[],
  env: Record<string, string> = {},
): Promise<{
  body: Record<string, unknown> | undefined;
  exitCode: number;
  stderr: string;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return Response.json({ ok: true, status: "spooled", id: "test" });
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "cli.ts"), "notify", ...args],
      {
        env: { ...process.env, ...env, AGENT_MAIL_PORT: String(server.port) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    return { body: requests[0], exitCode: await child.exited, stderr };
  } finally {
    server.stop(true);
  }
}

test("notify --session addresses one live session instead of broadcasting", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-session-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(home, ".claude", "agent-mail", "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  // A registration is only live if its pid AND process start time still match,
  // so borrow this test process's real identity rather than inventing a pid.
  const self = processInfo([process.pid]).get(process.pid);
  const canonical = realpathSync(project);
  writeFileSync(
    join(registry, `${projectSlug(canonical)}-${process.pid}.json`),
    JSON.stringify({
      cwd: canonical,
      pid: process.pid,
      ...(self ? { procStart: self.start } : {}),
      sessionId: "submitter-session",
      started: new Date().toISOString(),
    }),
  );

  try {
    const addressed = await notifyRequest(
      [
        "--project",
        project,
        "--message",
        "job done",
        "--session",
        "submitter-session",
      ],
      { HOME: home },
    );
    expect(addressed.exitCode).toBe(0);
    expect(addressed.body?.meta).toEqual({ toSession: "submitter-session" });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("notify reports delivery when the daemon stored the message but lost its reply", async () => {
  // The observed defect. The daemon appended the message and then failed to
  // return a response; the CLI fell back to a direct append, found the daemon's
  // own line in the shared spool, and reported "duplicate suppressed" — telling
  // the caller their message was dropped when it had been delivered. Those call
  // for opposite reactions, so they must not render the same.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-lost-reply-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const inbox = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(project, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const canonical = realpathSync(project);
  const spool = join(inbox, `${projectSlug(canonical)}.jsonl`);

  // Stands in for the daemon: append exactly what it would have appended, then
  // never answer, so the client times out the way it did in the field.
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const sent = (await request.json()) as { attemptKey?: string };
      writeFileSync(
        spool,
        `${JSON.stringify({
          id: "daemon-stored-id",
          ts: new Date().toISOString(),
          from: "cli",
          project: canonical,
          message: "job done",
          attemptKey: sent.attemptKey,
        })}\n`,
      );
      return await new Promise<Response>(() => {});
    },
  });

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "notify",
        "--project",
        project,
        "--message",
        "job done",
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          AGENT_MAIL_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("daemon-stored-id");
    expect(out).not.toContain("duplicate suppressed");

    // And the guard still did its job: one copy in the spool, not two.
    const lines = readFileSync(spool, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
