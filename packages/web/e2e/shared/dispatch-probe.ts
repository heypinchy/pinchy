// packages/web/e2e/shared/dispatch-probe.ts
//
// Cross-suite helpers for the per-plugin "dispatch probe" describe blocks.
// Each probe proves that a Pinchy plugin loaded into OpenClaw, its
// registerTool() call took effect, and a fake-LLM tool_call produces an
// audit-log entry. The probes share four chores:
//
//   1. Seed `default_provider=ollama-local` + `ollama_local_url` into settings,
//      with rollback in afterAll so global state is not leaked across tests.
//   2. Wait for OpenClaw to load the new config and report `connected=true`
//      for 5 consecutive seconds — a single transient `true` would race the
//      hot-reload cycle.
//   3. Drive the UI login form so the Playwright `page` has a session cookie
//      independent of the bearer-cookie used by the API helpers.
//   4. Poll `/api/audit?eventType=tool.<toolName>` for the dispatched call.
//
// Keeping these here means dispatch probes for new plugins inherit fixes by
// default (e.g., rollback behavior, stability semantics) instead of forking.

import type { Page } from "@playwright/test";

const SETTING_KEYS = ["default_provider", "ollama_local_url"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

type SettingRow = { key: SettingKey; value: string; encrypted: boolean };

/**
 * Swap `default_provider` to fake-Ollama and seed `ollama_local_url`. Returns
 * a rollback function that restores the original rows (or deletes them if
 * they did not exist before) so subsequent tests are not polluted.
 */
export async function seedDefaultProviderToOllama(
  dbUrl: string,
  fakeOllamaPort: number
): Promise<() => Promise<void>> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  const existingRows = await sql<SettingRow[]>`
    SELECT key, value, encrypted FROM settings
    WHERE key IN ('default_provider', 'ollama_local_url')
  `;
  const originalByKey = new Map<SettingKey, { value: string; encrypted: boolean }>();
  for (const row of existingRows) {
    originalByKey.set(row.key, { value: row.value, encrypted: row.encrypted });
  }

  const ollamaUrl = `http://ollama.local:${fakeOllamaPort}`;
  await sql`
    INSERT INTO settings (key, value, encrypted) VALUES
      ('ollama_local_url', ${ollamaUrl}, false),
      ('default_provider', 'ollama-local', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = false
  `;
  await sql.end();

  return async () => {
    const sql2 = postgres(dbUrl);
    try {
      for (const key of SETTING_KEYS) {
        const original = originalByKey.get(key);
        if (original) {
          await sql2`
            UPDATE settings
            SET value = ${original.value}, encrypted = ${original.encrypted}
            WHERE key = ${key}
          `;
        } else {
          await sql2`DELETE FROM settings WHERE key = ${key}`;
        }
      }
    } finally {
      await sql2.end();
    }
  };
}

/**
 * Wait until `/api/health/openclaw` reports `connected=true` for `stableForMs`
 * consecutive milliseconds. A single transient `true` during a hot-reload
 * cycle is not enough — config-regen briefly tears down the bridge and a
 * naive poll catches the pre-reload state.
 */
export async function waitForOpenClawStable(
  fetchHealth: () => Promise<{ ok: boolean; json: () => Promise<{ connected?: boolean }> }>,
  opts: { deadlineMs?: number; stableForMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const stableFor = opts.stableForMs ?? 5_000;
  const interval = opts.intervalMs ?? 500;
  let connectedSince: number | null = null;

  while (Date.now() < deadline) {
    const res = await fetchHealth();
    if (res.ok) {
      const body = await res.json();
      if (body.connected) {
        connectedSince ??= Date.now();
        if (Date.now() - connectedSince >= stableFor) return;
      } else {
        connectedSince = null;
      }
    } else {
      connectedSince = null;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `OpenClaw did not stabilise (connected=true for ${String(stableFor)}ms) within deadline`
  );
}

/**
 * Drive the UI login form so the Playwright `page` has a session cookie.
 * Asserts the post-login redirect to `/chat/...` so the next navigation does
 * not race the auth roundtrip.
 */
export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  const { expect } = await import("@playwright/test");
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 });
}

/**
 * Poll `/api/audit?eventType=tool.<toolName>` until an entry for the given
 * agent + tool combination appears, or the deadline elapses. Returns true on
 * success.
 */
export async function pollAuditForTool(
  page: Page,
  params: { toolName: string; agentId: string; deadlineMs?: number; intervalMs?: number }
): Promise<boolean> {
  const deadline = Date.now() + (params.deadlineMs ?? 30_000);
  const interval = params.intervalMs ?? 500;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/audit?eventType=tool.${params.toolName}&limit=10`);
    if (res.status() === 200) {
      const audit = (await res.json()) as {
        entries: Array<{ resource: string | null; detail: { toolName?: string } | null }>;
      };
      const found = audit.entries.some(
        (entry) =>
          entry.resource === `agent:${params.agentId}` && entry.detail?.toolName === params.toolName
      );
      if (found) return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
