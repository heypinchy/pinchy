import type { OpenClawClient } from "openclaw-node";

// Use globalThis to share the client across module boundaries.
// Next.js may load API routes in a separate module context from server.ts,
// so a plain module-level variable wouldn't be shared.
const GLOBAL_KEY = "__openclawClient" as const;

declare global {
  // eslint-disable-next-line no-var
  var __openclawClient: OpenClawClient | undefined;
}

export function setOpenClawClient(client: OpenClawClient): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = client;
}

export function getOpenClawClient(): OpenClawClient {
  const client = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as OpenClawClient | undefined;
  if (!client) {
    throw new Error("OpenClaw client not initialized");
  }
  return client;
}
