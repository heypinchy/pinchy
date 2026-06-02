"use client";

import { useState, useEffect, useCallback } from "react";
import type { ModelCapabilities } from "@/lib/model-capabilities/types";

export type ModelCapabilityMap = Record<string, ModelCapabilities>;

let moduleCache: ModelCapabilityMap | undefined;
let inflight: Promise<ModelCapabilityMap> | null = null;
const listeners = new Set<() => void>();

/**
 * @internal — test helper only. Clears the module-level cache and in-flight
 * promise so each test starts from a clean slate. Never call from production
 * code; use `invalidateModelCapabilityCache()` on the server side instead.
 */
export function _resetModuleCacheForTest(): void {
  moduleCache = undefined;
  inflight = null;
  listeners.clear();
}

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

async function fetchCapabilities(): Promise<ModelCapabilityMap> {
  const res = await fetch("/api/models/capabilities");
  if (!res.ok) throw new Error(`Failed to load model capabilities: ${res.status}`);
  return res.json();
}

// Coalesces concurrent loads — multiple components mounting on the same tick
// share a single in-flight request instead of each triggering their own GET.
function loadShared(): Promise<ModelCapabilityMap> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const caps = await fetchCapabilities();
      moduleCache = caps;
      notifyListeners();
      return caps;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useModelCapabilities(): {
  data: ModelCapabilityMap | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => void;
} {
  const [data, setData] = useState<ModelCapabilityMap | undefined>(moduleCache);
  const [isLoading, setIsLoading] = useState(!moduleCache);
  const [error, setError] = useState<Error | undefined>();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const caps = await loadShared();
      setData(caps);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!moduleCache) {
      load();
    }

    const sync = () => setData(moduleCache);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [load]);

  return { data, isLoading, error, refetch: load };
}
