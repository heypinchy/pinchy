"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface RestartContextValue {
  isRestarting: boolean;
  triggerRestart: () => void;
}

const RestartContext = createContext<RestartContextValue>({
  isRestarting: false,
  triggerRestart: () => {},
});

export function useRestart() {
  return useContext(RestartContext);
}

const POLL_INTERVAL_MS = 2000;

export function RestartProvider({ children }: { children: React.ReactNode }) {
  const [isRestarting, setIsRestarting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health/openclaw");
      const data = await res.json();
      if (data.status === "ok") {
        setIsRestarting(false);
      } else if (data.status === "restarting") {
        setIsRestarting(true);
      }
    } catch {
      // Keep current state on fetch error — polling will retry
    }
  }, []);

  const triggerRestart = useCallback(() => {
    setIsRestarting(true);
  }, []);

  // Mount-time health check — subscribes to external health endpoint
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health/openclaw")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.status === "restarting") {
          setIsRestarting(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while restarting
  useEffect(() => {
    if (isRestarting) {
      pollingRef.current = setInterval(checkHealth, POLL_INTERVAL_MS);
    } else if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isRestarting, checkHealth]);

  return (
    <RestartContext.Provider value={{ isRestarting, triggerRestart }}>
      {children}
      {isRestarting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
            <p className="text-lg font-medium">Applying changes</p>
            <p className="text-sm text-muted-foreground">Your agents will be back in a moment.</p>
          </div>
        </div>
      )}
    </RestartContext.Provider>
  );
}
