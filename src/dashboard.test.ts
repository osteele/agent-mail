import { expect, test } from "bun:test";
import { dashboardResponse } from "./dashboard.ts";

test("the persistent daemon can serve the dashboard page", async () => {
  const response = dashboardResponse(new Request("http://127.0.0.1:8377/"));
  expect(response?.status).toBe(200);
  const page = await response?.text();
  expect(page).toContain("agent-mail");
  expect(page).toContain("Coordination");
  expect(page).toContain("recover_coordination");
});
