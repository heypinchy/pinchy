import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export async function login(page: Page) {
  const setup = await page.request.post("/api/setup", {
    data: {
      name: "Integration Admin",
      email: "admin@integration.local",
      password: "integration-password-123",
    },
  });
  expect([201, 403]).toContain(setup.status());

  await page.goto("/login");
  await page.getByLabel(/email/i).fill("admin@integration.local");
  await page.getByLabel("Password", { exact: true }).fill("integration-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
}

export async function getSmithersAgentId(page: Page) {
  const res = await page.request.get("/api/agents");
  const agents = await res.json();
  const smithers = agents.find((a: { name: string }) => a.name === "Smithers");
  expect(smithers).toBeTruthy();
  return smithers.id as string;
}

export async function waitForOpenClawConnected(page: Page, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let connectedSince: number | null = null;
  while (Date.now() < deadline) {
    const health = await page.request.get("/api/health/openclaw");
    const data = await health.json();
    if (data.connected) {
      connectedSince ??= Date.now();
      if (Date.now() - connectedSince >= 5000) return;
    } else {
      connectedSince = null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OpenClaw did not connect within ${timeoutMs}ms`);
}
