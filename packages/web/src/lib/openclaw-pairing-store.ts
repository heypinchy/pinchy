// Telegram pairing codes and allow lists, read and written through OpenClaw.
//
// Up to OpenClaw 2026.8 both were JSON files under `credentials/` on the shared
// volume, and Pinchy read and wrote them directly. OpenClaw 2026.9 keeps them
// in its state database, which only the gateway process can open safely, so
// the pinchy-audit plugin serves them as gateway methods and Pinchy calls those
// over the connection it already holds.

import { getOpenClawClient } from "@/server/openclaw-client";

/** Served by packages/plugins/pinchy-audit/channel-pairing-store.ts. */
export const PAIRING_FIND_BY_CODE_METHOD = "pinchy.pairing.findByCode";
export const PAIRING_REMOVE_REQUESTS_METHOD = "pinchy.pairing.removeRequests";
export const PAIRING_SET_ALLOW_FROM_METHOD = "pinchy.pairing.setAllowFrom";

/**
 * The gateway is not connected, so the call was not made. Callers that write
 * can skip: Pinchy recomputes the allow lists whenever the connection comes
 * back (server.ts).
 */
export class OpenClawNotConnectedError extends Error {
  constructor() {
    super("OpenClaw is not connected");
    this.name = "OpenClawNotConnectedError";
  }
}

export async function callPairingStore(
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = getOpenClawClient();
  } catch {
    throw new OpenClawNotConnectedError();
  }
  if (!client.isConnected) throw new OpenClawNotConnectedError();

  // openclaw-node resolves an error response rather than rejecting.
  const response = await client.request(method, { channel: "telegram", ...params });
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error?.message ?? "no reason given"}`);
  }
  return (response.payload ?? {}) as Record<string, unknown>;
}
