import { randomUUID } from "crypto";

interface PendingFlow {
  deviceCode: string;
  clientId: string;
  interval: number;
  expiresAt: number; // epoch ms
  createdAt: number;
}

const FLOWS = new Map<string, PendingFlow>();

export function createPendingFlow(flow: Omit<PendingFlow, "createdAt">): string {
  const flowId = randomUUID();
  FLOWS.set(flowId, { ...flow, createdAt: Date.now() });
  return flowId;
}

export function getPendingFlow(flowId: string): PendingFlow | null {
  const flow = FLOWS.get(flowId);
  if (!flow) return null;
  if (Date.now() > flow.expiresAt) {
    FLOWS.delete(flowId);
    return null;
  }
  return flow;
}

export function deletePendingFlow(flowId: string): void {
  FLOWS.delete(flowId);
}

/** Test-only: purge all state. */
export function clearPendingFlows(): void {
  FLOWS.clear();
}

// Single source of truth for Codex OAuth constants (verified from openai/codex source 2026-04-20)
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const OPENAI_CODEX_DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_CODEX_POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";
