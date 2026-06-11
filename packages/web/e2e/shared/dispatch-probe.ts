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
 * Wait until `/api/health/openclaw` reports `connected=true` AND
 * `configPushesPending=0` for `stableForMs` consecutive milliseconds. A single
 * transient `true` during a hot-reload cycle is not enough — config-regen
 * briefly tears down the bridge and a naive poll catches the pre-reload state.
 *
 * Why `configPushesPending` is part of the predicate: Pinchy's
 * `pushConfigInBackground` is fire-and-forget, and OC 5.3's `config.apply`
 * rate-limit (~3 calls / 45 s window) can PARK a push coroutine for 33–53 s
 * waiting out the window. OC stays connected the whole time, so a
 * connection-only stability window passes while a config change this suite
 * just made (e.g. the per-agent `pinchy-email` grant) is still NOT in OC's
 * runtime. The next dispatch then snapshots a tool list without the grant and
 * the agent answers "I can't use the tool … it isn't available" (the
 * email/odoo/web/telegram dispatch-probe flake, sibling of #464). Requiring
 * pending=0 makes the gate deterministic instead of probabilistic.
 */
export async function waitForOpenClawStable(
  fetchHealth: () => Promise<{
    ok: boolean;
    json: () => Promise<{ connected?: boolean; configPushesPending?: number }>;
  }>,
  opts: { deadlineMs?: number; stableForMs?: number; intervalMs?: number } = {}
): Promise<void> {
  // 150 s default deadline (was 90 s): a parked config.apply can take one full
  // rate-limit window (~53 s) — or two (~100 s) before the file-write fallback
  // settles it — BEFORE the stableFor window can even begin. 90 s could expire
  // mid-wait and turn the deterministic gate back into a flake.
  const deadline = Date.now() + (opts.deadlineMs ?? 150_000);
  const stableFor = opts.stableForMs ?? 30_000;
  const interval = opts.intervalMs ?? 500;
  let stableSince: number | null = null;

  while (Date.now() < deadline) {
    const res = await fetchHealth();
    let stable = false;
    if (res.ok) {
      const body = await res.json();
      // Missing `configPushesPending` (older Pinchy build) counts as settled
      // so the helper stays usable against both response shapes.
      stable = Boolean(body.connected) && (body.configPushesPending ?? 0) === 0;
    }
    if (stable) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableFor) return;
    } else {
      stableSince = null;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `OpenClaw did not stabilise (connected=true with configPushesPending=0 for ${String(stableFor)}ms) within deadline`
  );
}

/**
 * Poll `GET /api/health/openclaw?agentId=<id>` until the response's
 * `agentDispatchable` flag is true — i.e. OC's runtime `agents.list`
 * currently contains the requested id.
 *
 * Why this is needed alongside `waitForOpenClawStable`: stability only
 * checks `connected=true` for a contiguous window. It does NOT verify the
 * agent the test is about to dispatch to is actually in OC's hot-loaded
 * config. After a `PATCH /api/agents/:id` or `PUT /api/agents/:id/integrations`
 * (both fire-and-forget regenerates), OC's hot-reload can still be in
 * flight when the API returns 200. Worse: if Pinchy's prior tests
 * exhausted OC's `config.apply` rate-limit window (~3 calls / 45 s),
 * the probe's regens fall through to the inotify file-watcher fallback
 * whose debounce can stretch past the stability check. The result is
 * "unknown agent id" errors when the test fires its chat.
 *
 * Tests that immediately dispatch to an agent created earlier in their
 * `beforeAll` should call this AFTER `waitForOpenClawStable` and before
 * issuing the chat.
 */
export async function waitForAgentDispatchable(
  fetchHealth: (
    agentId: string
  ) => Promise<{ ok: boolean; json: () => Promise<{ agentDispatchable?: boolean }> }>,
  agentId: string,
  opts: { deadlineMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const interval = opts.intervalMs ?? 500;

  while (Date.now() < deadline) {
    const res = await fetchHealth(agentId);
    if (res.ok) {
      const body = await res.json();
      if (body.agentDispatchable === true) return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `OpenClaw runtime did not see agent ${agentId} as dispatchable within deadline — config.apply likely stuck in file-watcher debounce`
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
 *
 * Default deadline is 60 s, not 30 s, because the dispatch path includes
 * a chat UI navigation (Playwright nav + WS connect + LLM round-trip via
 * fake-ollama + OC tool dispatch + audit write). On a clean CI runner the
 * happy path completes in 5–10 s, but transient OC reconnects after a
 * config.apply still in flight can add 20+ s before the agent is dispatchable.
 * 30 s sat right at that race window and produced sporadic CI failures
 * (e.g. run 26038713754) — 60 s leaves comfortable slack without masking
 * real "tool was never called" bugs.
 */
export async function pollAuditForTool(
  page: Page,
  params: {
    toolName: string;
    agentId: string;
    deadlineMs?: number;
    intervalMs?: number;
    /**
     * ISO-8601 timestamp. When provided, the audit query filters out
     * entries written before this moment. Tests that re-use the same
     * tool name on the same agent within a single spec file MUST
     * capture `since = new Date().toISOString()` BEFORE triggering the
     * dispatch and pass it here — otherwise the helper would return
     * `true` immediately by matching a previous test's audit entry, and
     * a follow-up "side-effect actually happened" assertion would race
     * against the still-in-flight dispatch.
     */
    since?: string;
  }
): Promise<boolean> {
  const deadline = Date.now() + (params.deadlineMs ?? 60_000);
  const interval = params.intervalMs ?? 500;
  const sinceQs = params.since ? `&from=${encodeURIComponent(params.since)}` : "";
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/audit?eventType=tool.${params.toolName}&limit=10${sinceQs}`
    );
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
