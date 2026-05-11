"use client";
import { useEffect, useState } from "react";

export function useIntegrationHealth(enabled: boolean): { authFailedCount: number } {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/integrations/health");
        if (!res.ok) return;
        const data = (await res.json()) as { authFailedCount: number };
        if (!cancelled) setCount(data.authFailedCount);
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
  return { authFailedCount: count };
}
