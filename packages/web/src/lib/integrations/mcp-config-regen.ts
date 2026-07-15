import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

/**
 * Regenerates openclaw.json after an MCP connection's auth status changed.
 *
 * WHY THIS EXISTS AT ALL — MCP's gating lives in the config, not in a plugin.
 * `build.ts` only emits `mcp.servers` + per-agent `tools.allow` for connections
 * with `status === "active"`, so an auth-status transition is config-relevant
 * in BOTH directions:
 *   - active → auth_failed: the server entry must drop out, or OpenClaw keeps
 *     retrying a failing initialize handshake on every reload and the config
 *     claims a reachability that no longer exists.
 *   - auth_failed → active: the agent's existing grants stay fail-closed until
 *     the server entry comes back.
 * Odoo/email/imap need none of this — they fetch credentials and check
 * permissions at tool-call time, so their status never reaches openclaw.json.
 * Hence the `connectionType` gate: non-MCP callers are a no-op, which keeps
 * every existing integration type's behavior byte-identical.
 *
 * WHY IT SWALLOWS FAILURES — the status change has already committed by the
 * time we get here; a failed config write must not be reported to the user as
 * a failure of the thing that actually succeeded. In the "Test Connection"
 * route this is not merely cosmetic: that handler's catch-all turns any throw
 * into `setIntegrationAuthFailed(reason: <the error>)`, so an unguarded regen
 * throw would flip a *healthy* connection to auth_failed purely because
 * openclaw.json couldn't be written. We log and move on instead; the next
 * regenerate (any config-touching action, or boot-inits) heals the config.
 * Note `regenerateOpenClawConfig` already returns silently on the EACCES
 * restart race (#314) — this guard covers everything else.
 */
export async function regenerateAfterMcpAuthTransition(connectionType: string): Promise<void> {
  if (connectionType !== "mcp") return;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error(
      "[mcp] openclaw.json regenerate after an MCP auth-status change failed. The status change " +
        "itself is persisted; the config will heal on the next regenerate.",
      err
    );
  }
}
