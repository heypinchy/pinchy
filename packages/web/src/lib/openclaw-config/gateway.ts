import { OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS } from "./paths";

/**
 * Builds the `gateway` block for openclaw.json.
 *
 * `mode` and `bind` are always set. `auth.token` is written as a plain string —
 * OpenClaw requires a literal string for gateway auth and does not resolve
 * SecretRef objects in the gateway.auth block. The same token is also written
 * to secrets.json so Pinchy can read it.
 *
 * OpenClaw's built-in Control UI is disabled: Pinchy IS the external control
 * surface (its own UI on port 7777), so OpenClaw's `/__openclaw__/control/*`
 * routes on port 18789 are unused, cost memory, and add attack surface. Per
 * OpenClaw's own schema guidance: "disable when an external control surface
 * replaces it."
 *
 * `controlUi.allowedOrigins` is ALWAYS emitted so OC's reload diff never sees
 * this restart-class field appear/disappear. OC's enriched value is preserved
 * when the config already carries a valid array (a prior config.apply persisted
 * it); otherwise we seed the same origins OC would. See
 * OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS in paths.ts for the full rationale.
 *
 * Pure given its inputs — `existingGateway` is spread through so any
 * OpenClaw-enriched sibling fields survive the regenerate untouched.
 */
export function buildGatewayBlock(
  existingGateway: Record<string, unknown>,
  gatewayTokenValue: string | null | undefined
): Record<string, unknown> {
  const existingControlUi = (existingGateway.controlUi as Record<string, unknown>) || {};
  return {
    ...existingGateway,
    mode: "local",
    bind: "lan",
    auth: {
      mode: "token",
      token: gatewayTokenValue || "",
    },
    controlUi: {
      ...existingControlUi,
      enabled: false,
      allowedOrigins: Array.isArray(existingControlUi.allowedOrigins)
        ? existingControlUi.allowedOrigins
        : OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS,
    },
  };
}
