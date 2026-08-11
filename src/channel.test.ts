import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
