import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
