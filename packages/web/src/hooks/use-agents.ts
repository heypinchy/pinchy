"use client";

import { useState, useEffect, useCallback } from "react";
import type { Agent } from "@/components/agent-list";

const POLL_INTERVAL_MS = 30_000;

export function useAgents(initialAgents: Agent[]): Agent[] {
  const [agents, setAgents] = useState(initialAgents);

  // Sync with SSR prop changes (e.g. after router.refresh())
  const [prevInitial, setPrevInitial] = useState(initialAgents);
  if (initialAgents !== prevInitial) {
    setPrevInitial(initialAgents);
    setAgents(initialAgents);
  }

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAgents(data);
        }
      }
    } catch {
      // Keep current agents on network error
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(refetch, POLL_INTERVAL_MS);

    window.addEventListener("focus", refetch);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refetch);
    };
  }, [refetch]);

  return agents;
}
