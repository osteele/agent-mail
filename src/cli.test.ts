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
