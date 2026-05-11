"use client";

import { useState, useEffect, useCallback } from "react";
import type { ModelCapabilities } from "@/lib/model-capabilities/cache";

export type ModelCapabilityMap = Record<string, ModelCapabilities>;

let moduleCache: ModelCapabilityMap | undefined;
const listeners = new Set<() => void>();

export function _resetModuleCacheForTest(): void {
  moduleCache = undefined;
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
      const caps = await fetchCapabilities();
      moduleCache = caps;
      setData(caps);
      notifyListeners();
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
