import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function textContent(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new TypeError("expected an MCP content result");
  }
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

test("claim_path accepts and releases an atomic path batch over MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const claimTool = tools.tools.find((tool) => tool.name === "claim_path");
    expect(claimTool?.inputSchema.properties).toHaveProperty("paths");

    await client.callTool({ name: "check_inbox" });
    const registry = join(home, ".claude", "agent-mail", "registry");
    const registrations = readdirSync(registry).map(
      (name) =>
        JSON.parse(readFileSync(join(registry, name), "utf8")) as {
          lastInboxPoll?: string;
        },
    );
    expect(registrations).toHaveLength(1);
    expect(registrations[0].lastInboxPoll).toBeDefined();

    const claimed = await client.callTool({
      name: "claim_path",
      arguments: { paths: ["Sources/Schedule.swift", "Checks/main.swift"] },
    });
    const claimedText = textContent(claimed);
    expect(claimedText).toContain("2 files claimed");
    const claimId = /claim ([0-9a-f-]+)/.exec(claimedText)?.[1];
    expect(claimId).toBeDefined();

    const active = await client.callTool({ name: "list_claims" });
    expect(textContent(active).split("\n")).toHaveLength(1);
    expect(textContent(active)).toContain("Sources/Schedule.swift");
    expect(textContent(active)).toContain("Checks/main.swift");

    await client.callTool({
      name: "release_claim",
      arguments: { claim_id: claimId },
    });
    const empty = await client.callTool({ name: "list_claims" });
    expect(textContent(empty)).toBe("no active claims");
  } finally {
    await client.close();
  }
});

test("logical work can be acquired, updated, listed, and released over MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-work-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("acquire_work");

    const acquired = await client.callTool({
      name: "acquire_work",
      arguments: {
        resource_type: "research-plan",
        resource_key: "2026-08-12-pilot",
        label: "Pilot campaign",
        activity: "Startup audit",
      },
    });
    const acquiredText = textContent(acquired);
    expect(acquiredText).toContain("Pilot campaign");
    const workId = /acquired ([0-9a-f-]+)/.exec(acquiredText)?.[1];
    expect(workId).toBeDefined();

    const updated = await client.callTool({
      name: "update_work",
      arguments: {
        work_id: workId,
        state: "waiting",
        activity: "Waiting for job 42",
      },
    });
    expect(textContent(updated)).toContain("Waiting for job 42");

    const listed = await client.callTool({ name: "list_work" });
    expect(textContent(listed)).toContain("research-plan:2026-08-12-pilot");
    expect(textContent(listed)).toContain("[waiting]");

    await client.callTool({
      name: "release_work",
      arguments: { work_id: workId },
    });
    expect(textContent(await client.callTool({ name: "list_work" }))).toBe(
      "no active work",
    );
  } finally {
    await client.close();
  }
});

test("coordination tools expose and recover only dead-session records", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-recovery-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const claimDirectory = join(home, ".claude", "agent-mail", "claims", slug);
  mkdirSync(claimDirectory, { recursive: true });
  writeFileSync(
    join(claimDirectory, "stale-claim.json"),
    JSON.stringify({
      id: "stale-claim",
      type: "path",
      project: canonical,
      path: join(canonical, "notes.md"),
      pathType: "file",
      owner: {
        id: "dead-session",
        label: "Offline Agent",
        sessionId: "dead-session",
        pid: 999_999,
      },
      createdAt: "2026-08-12T00:00:00.000Z",
    }),
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("list_coordination");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "recover_coordination",
    );
    const listed = await client.callTool({ name: "list_coordination" });
    expect(textContent(listed)).toContain("stale-claim");
    expect(textContent(listed)).toContain("[owner-offline]");

    const recovered = await client.callTool({
      name: "recover_coordination",
      arguments: { coordination_id: "stale-claim" },
    });
    expect(textContent(recovered)).toContain("Offline Agent");
    expect(
      textContent(await client.callTool({ name: "list_coordination" })),
    ).toBe("no active coordination");
  } finally {
    await client.close();
  }
});
