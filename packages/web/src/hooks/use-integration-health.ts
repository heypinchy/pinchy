"use client";
import { useEffect, useState } from "react";
import type { IntegrationHealthCounts } from "@/lib/integrations/connection-health";

/**
 * Polls the health endpoint and returns how many connections "need attention"
 * (auth_failed OR cannotDecrypt). Drives the sidebar Settings badge and the
 * Integrations-tab error dot. Best-effort: failures leave the count at 0.
 */
export function useIntegrationHealth(enabled: boolean): { needsAttentionCount: number } {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/integrations/health");
        if (!res.ok) return;
        const data = (await res.json()) as Partial<IntegrationHealthCounts>;
        if (!cancelled) setCount(data.needsAttentionCount ?? 0);
      } catch {
        /* badge is best-effort */
      }
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return { needsAttentionCount: count };
}
