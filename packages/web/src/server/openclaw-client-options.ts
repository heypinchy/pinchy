import type { OpenClawClient } from "openclaw-node";

type OpenClawClientOptions = ConstructorParameters<typeof OpenClawClient>[0];

/**
 * How Pinchy's one gateway connection identifies itself to OpenClaw.
 *
 * `caps: ["plugin-approvals"]`: since 2026.9 OpenClaw hands a plugin approval
 * only to a client that announced it can take one (`canDeliverApprovals`); an
 * admin scope alone no longer counts. Without it, every tool call that
 * pinchy-approvals gates ended "Plugin approval unavailable (no approval
 * route)" before Pinchy ever saw the request. openclaw-node 0.14.0 always sent
 * `caps: []`; patches/openclaw-node@0.14.0.patch lets the option through.
 */
export function openClawClientOptions(params: {
  url: string;
  token: string;
  deviceIdentityPath: string;
}): OpenClawClientOptions {
  return {
    url: params.url,
    token: params.token,
    clientId: "gateway-client",
    clientVersion: "0.1.0",
    scopes: ["operator.admin"],
    caps: ["plugin-approvals"],
    deviceIdentityPath: params.deviceIdentityPath,
    autoReconnect: true,
    reconnectIntervalMs: 1000,
    maxReconnectAttempts: Infinity,
  };
}
