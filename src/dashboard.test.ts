import { expect, test } from "bun:test";
import { dashboardResponse } from "./dashboard.ts";
import type { DashboardState } from "./dashboardData.ts";

test("the persistent daemon can serve the dashboard page", async () => {
  const response = dashboardResponse(new Request("http://127.0.0.1:8377/"));
  expect(response?.status).toBe(200);
  const page = await response?.text();
  expect(page).toContain("agent-mail");
  expect(page).toContain("Coordination");
  expect(page).toContain("recover_coordination");
});

// This asserts on the schema, but the endpoint runs a real process scan
// (listLive → per-pid `ps`), so wall time scales with the number of attached
// agent sessions and machine load — the default 5s limit tips over when the
// suite runs on a busy machine.
test(
  "the versioned state endpoint uses the non-mutating schema",
  async () => {
    const response = dashboardResponse(
      new Request("http://127.0.0.1/api/v1/state"),
    );
    expect(response?.status).toBe(200);
    const state = (await response?.json()) as DashboardState;
    expect(state.schemaVersion).toBe(1);
    expect(state.source.mode).toBe("filesystem-snapshot");
    expect(Array.isArray(state.messages)).toBe(true);
    expect(Array.isArray(state.coordination)).toBe(true);
    expect(Array.isArray(state.transfers)).toBe(true);
  },
  { timeout: 20_000 },
);
