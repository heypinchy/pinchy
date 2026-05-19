"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js on mount, in production only.
 *
 * Why production-only: Next.js dev mode + service workers produce confusing
 * caching artifacts (HMR can race against SW lifecycle). The stub SW does
 * nothing useful in dev, so we just skip it.
 *
 * Failure is swallowed silently — a missing SW must never break the app.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Intentionally silent: SW registration failure should not crash the UI.
    });
  }, []);
  return null;
}
