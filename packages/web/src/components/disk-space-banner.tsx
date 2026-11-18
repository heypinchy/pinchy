"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiGet } from "@/lib/api-client";
import { DocsLink } from "@/components/docs-link";
import type { DiskReport } from "@/lib/disk-space";

const REFETCH_INTERVAL_MS = 5 * 60 * 1000;
const DISMISS_KEY = "pinchy-banner-dismissed:disk:warning";

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The admin's warning that the server is running low on disk space (#1379).
 * It reads the same `disk` report `/api/health` publishes, so the banner and
 * any external monitor agree on what "low" means. Stays up until dismissed for
 * the session: a full disk takes days to fix, not seconds.
 */
export function DiskSpaceBanner({ isAdmin }: { isAdmin: boolean }) {
  const [disk, setDisk] = useState<DiskReport | null>(null);
  const [, setDismissTick] = useState(0);

  const fetchDisk = useCallback(() => {
    apiGet<{ disk?: DiskReport }>("/api/health")
      .then((health) => setDisk(health?.disk ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetchDisk();
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchDisk();
    };
    const interval = setInterval(fetchDisk, REFETCH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAdmin, fetchDisk]);

  if (!isAdmin || disk?.status !== "warning" || isDismissed()) return null;

  const low = disk.volumes.filter((v) => v.status === "warning");
  if (low.length === 0) return null;
  const freeGb = Math.min(...low.map((v) => v.freeGb));

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable: the bar hides for this render only.
    }
    setDismissTick((t) => t + 1);
  };

  return (
    <div
      role="alert"
      data-testid="disk-space-banner"
      className="relative px-8 py-2 text-sm text-center bg-amber-500 text-white"
    >
      Your server is running low on disk space: {freeGb} GB free. The knowledge-base index,
      converted documents and Docker images all grow there, and the next upgrade needs about 10 GB
      to download.{" "}
      <DocsLink path="guides/hardening" hash="disk-space" className="underline font-medium">
        Free up space
      </DocsLink>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
