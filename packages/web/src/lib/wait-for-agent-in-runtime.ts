import type { OpenClawClient } from "openclaw-node";

/**
 * Poll OpenClaw's runtime config until the freshly-created agent shows up in
 * `agents.list`, or the timeout elapses.
 *
 * Why: Pinchy's `regenerateOpenClawConfig()` is intentionally fire-and-forget
 * (`pushConfigInBackground`) because `config.apply` can take 10–30 s if a
 * gateway restart is required, and that would block interactive UI saves
 * (Odoo "Save & Restart", agent create). The downside is a race window
 * between `POST /api/agents` returning 201 and OC's hot-reload actually
 * applying the new `agents.list`. A test that immediately dispatches a
 * message to the new agent hits `invalid agent params: unknown agent id`
 * (closed issue #200 in a different code path, now resurfaced on the OC
 * 5.12+ v4 cliff because the reload pipeline's `agents.list` is applied
 * marginally later than the secrets/plugins blocks).
 *
 * This helper closes that window for the agent-create call site only: it
 * polls `config.get` (cheap, no restart trigger) every 200 ms for up to
 * 5 s. The poll returns once `agents.list` carries the requested id, so
 * the API response only returns 201 when the runtime is ready to
 * dispatch. Timeout is best-effort (we still return 201) — production
 * UI then retries on its own and a subsequent dispatch wins.
 */
export async function waitForAgentInRuntime(
  client: OpenClawClient | null,
  agentId: string,
  timeoutMs = 5000,
  pollIntervalMs = 200
): Promise<boolean> {
  if (!client) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = (await client.config.get()) as {
        config?: {
          agents?: { list?: Array<{ id?: string }> };
        };
      };
      const list = result?.config?.agents?.list ?? [];
      if (list.some((a) => a?.id === agentId)) return true;
    } catch {
      // Transient WS errors during reload: keep polling.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}
