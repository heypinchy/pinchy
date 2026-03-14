import type { OpenClawClient } from "openclaw-node";

let _client: OpenClawClient | null = null;

export function setOpenClawClient(client: OpenClawClient): void {
  _client = client;
}

export function getOpenClawClient(): OpenClawClient {
  if (!_client) {
    throw new Error("OpenClaw client not initialized");
  }
  return _client;
}
