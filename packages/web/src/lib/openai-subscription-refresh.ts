import { getOpenAiSubscription, setOpenAiSubscription } from "@/lib/openai-subscription";
import { refreshAccessToken } from "@pinchy/openai-subscription-oauth";
import { OPENAI_CODEX_CLIENT_ID } from "@/lib/openai-oauth-state";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { appendAuditLog } from "@/lib/audit";

const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

export async function refreshStaleTokens(): Promise<void> {
  let current;
  try {
    current = await getOpenAiSubscription();
  } catch {
    // Malformed stored data — don't crash the background job
    return;
  }

  if (!current) return;

  const expiresMs = new Date(current.expiresAt).getTime();
  if (expiresMs - Date.now() > REFRESH_THRESHOLD_MS) return;

  try {
    const next = await refreshAccessToken({
      refresh: current.refreshToken,
      clientId: OPENAI_CODEX_CLIENT_ID,
    });
    await setOpenAiSubscription({
      ...current,
      accessToken: next.access,
      refreshToken: next.refresh,
      expiresAt: new Date(next.expires).toISOString(),
      lastRefreshAt: new Date().toISOString(),
      refreshFailureCount: 0,
    });
    await regenerateOpenClawConfig();
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "config.changed",
      resource: "settings:openai_subscription",
      outcome: "success",
      detail: { event: "token_refreshed", provider: "openai", accountEmail: current.accountEmail },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setOpenAiSubscription({
      ...current,
      refreshFailureCount: current.refreshFailureCount + 1,
    });
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "config.changed",
      resource: "settings:openai_subscription",
      outcome: "failure",
      error: { message },
      detail: {
        event: "token_refresh_failed",
        provider: "openai",
        accountEmail: current.accountEmail,
        failureCount: current.refreshFailureCount + 1,
      },
    });
  }
}
