"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import { ReportIssueLink } from "@/components/report-issue-link";
import type { DiagnosticsResult } from "@/lib/github-issue";

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
const TIMEOUT_MS = 30_000;

export function RestartProvider({ children }: { children: React.ReactNode }) {
  const [isRestarting, setIsRestarting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (isRestarting && !timedOut) {
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
  }, [isRestarting, timedOut, checkHealth]);

  // Timeout — show error state if restart takes too long
  useEffect(() => {
    if (isRestarting && !timedOut) {
      timeoutRef.current = setTimeout(() => setTimedOut(true), TIMEOUT_MS);
    } else if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isRestarting, timedOut]);

  // Fetch diagnostics when timeout fires
  useEffect(() => {
    if (!timedOut) return;
    let cancelled = false;
    fetch("/api/diagnostics")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setDiagnostics(data as DiagnosticsResult);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [timedOut]);

  return (
    <RestartContext.Provider value={{ isRestarting, triggerRestart }}>
      {children}
      {isRestarting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-center max-w-sm px-4">
            {timedOut ? (
              <>
                <p className="text-lg font-medium">This is taking longer than expected</p>
                <p className="text-sm text-muted-foreground">
                  The agent runtime did not come back up.
                </p>
                {diagnostics && (
                  <div className="w-full rounded-lg border bg-muted/50 p-3 space-y-2">
                    <StatusRow label="Database" status={diagnostics.database} />
                    <StatusRow label="OpenClaw" status={diagnostics.openclaw} />
                  </div>
                )}
                <ReportIssueLink error="OpenClaw restart timed out" />
              </>
            ) : (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
                <p className="text-lg font-medium">Applying changes</p>
                <p className="text-sm text-muted-foreground">
                  Hang tight — it&apos;ll only take a moment.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </RestartContext.Provider>
  );
}

function StatusRow({ label, status }: { label: string; status: string }) {
  const ok = status === "connected";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-medium ${ok ? "text-green-600" : "text-red-600"}`}
      >
        {ok ? <CircleCheck className="h-4 w-4" /> : <CircleX className="h-4 w-4" />}
        {status}
      </span>
    </div>
  );
}
