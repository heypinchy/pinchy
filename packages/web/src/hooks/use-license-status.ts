"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiGet } from "@/lib/api-client";
import type { LicenseInfo } from "@/lib/enterprise";

/**
 * Backoff between attempts after a failed status fetch. The last value repeats
 * for as long as the component stays mounted: a dev server's tsx-watch restart
 * takes 20–40 s, a production container restart about as long, and the answer
 * is worth having once it comes back.
 */
export const LICENSE_STATUS_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** One toast for every mounted caller: sonner replaces a toast with the same id. */
export const LICENSE_STATUS_TOAST_ID = "license-status-unavailable";

/**
 * A request held open by a restarting server or a proxy would never settle,
 * and an attempt that never settles never schedules its retry.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const UNAVAILABLE_MESSAGE = "Couldn't load your license status. We'll keep trying.";

/**
 * Every mounted instance that currently has the shared toast up. The settings
 * page mounts several callers at once, and one of them recovering or
 * unmounting must not take down the toast the others still stand behind.
 */
const failingNotifiers = new Set<object>();

function raiseToast(owner: object) {
  failingNotifiers.add(owner);
  // Stays up until the status arrives (or the caller goes away): the
  // component sits in its loading state the whole time, and a toast that
  // faded after 4 s would leave that unexplained.
  toast.error(UNAVAILABLE_MESSAGE, { id: LICENSE_STATUS_TOAST_ID, duration: Infinity });
}

function releaseToast(owner: object) {
  if (!failingNotifiers.delete(owner)) return;
  if (failingNotifiers.size === 0) toast.dismiss(LICENSE_STATUS_TOAST_ID);
}

/**
 * `GET /api/enterprise/status`, through the typed client.
 *
 * Rejects on anything that is not a status: a network failure, a non-2xx (a
 * 401 body is `{ error }`, a 500 is whatever the server managed), and a 200
 * without a boolean `enterprise` (a proxy's error page, a renamed field). A
 * caller that read any of those as `enterprise: false` would tell an
 * enterprise admin they are on Community and show them an upgrade card.
 */
export async function fetchLicenseStatus(signal?: AbortSignal): Promise<LicenseInfo> {
  const data = await apiGet<Partial<LicenseInfo> | undefined>("/api/enterprise/status", {
    signal,
  });
  if (typeof data?.enterprise !== "boolean") {
    throw new Error("License status response carries no enterprise flag");
  }
  return data as LicenseInfo;
}

interface UseLicenseStatusOptions {
  /** A status the server already rendered. Used as-is; no fetch on mount. */
  initial?: LicenseInfo | null;
  /**
   * While false, the hook starts a fetch only when `refetch()` is called (a
   * closed dialog; a list that refreshes the status together with its own
   * data). A failed `refetch()` still retries until it succeeds, the caller
   * unmounts, or `enabled`/`refreshKey` changes — so don't combine a changing
   * `refreshKey` with `enabled: false`.
   */
  enabled?: boolean;
  /** Changing it refetches. The last known status stays visible meanwhile. */
  refreshKey?: unknown;
  /**
   * Show a toast while the status cannot be read. For components that block
   * on the answer; decorative callers (a badge, a server-rendered default)
   * stay silent.
   */
  notifyOnFailure?: boolean;
}

/**
 * The license status as the client knows it. `license === null` means
 * *unknown* — not fetched yet, or every attempt so far failed — and callers
 * must render a loading state for it, never the community state.
 *
 * A failed fetch keeps the last known status and retries with backoff.
 */
export function useLicenseStatus({
  initial = null,
  enabled = true,
  refreshKey,
  notifyOnFailure = false,
}: UseLicenseStatusOptions = {}): {
  license: LicenseInfo | null;
  /** Fetch now. Resolves once this attempt settles, whatever its outcome. */
  refetch: () => Promise<void>;
} {
  const [license, setLicense] = useState<LicenseInfo | null>(initial);
  // Bumped by every new attempt and by unmount, so a stale response or a
  // retry scheduled by a superseded attempt cannot land.
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failures = useRef(0);
  // This instance's identity in `failingNotifiers`.
  const owner = useRef({}).current;
  const skipInitialFetch = useRef(initial !== null);

  // Drops the attempt in flight and its scheduled retry. The failure streak
  // and the toast carry over: a refreshKey change during an outage starts the
  // next attempt at once, and must not dismiss and re-show the toast (sonner
  // swallows a toast re-created that soon after dismissing its id).
  const stopAttempt = useCallback(() => {
    generation.current++;
    clearTimeout(retryTimer.current);
  }, []);

  // Nothing retries any more, so a toast promising "we'll keep trying" goes,
  // and the next attempt starts a fresh streak.
  const stopRetrying = useCallback(() => {
    stopAttempt();
    failures.current = 0;
    releaseToast(owner);
  }, [stopAttempt, owner]);

  const load = useCallback(async (): Promise<void> => {
    const gen = ++generation.current;
    clearTimeout(retryTimer.current);
    try {
      const next = await fetchLicenseStatus(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      if (gen !== generation.current) return;
      failures.current = 0;
      setLicense(next);
      releaseToast(owner);
    } catch {
      if (gen !== generation.current) return;
      const attempt = failures.current++;
      if (attempt === 0 && notifyOnFailure) raiseToast(owner);
      const delays = LICENSE_STATUS_RETRY_DELAYS_MS;
      retryTimer.current = setTimeout(
        () => void load(),
        delays[Math.min(attempt, delays.length - 1)]
      );
    }
  }, [notifyOnFailure, owner]);

  useEffect(() => {
    if (!enabled) {
      stopRetrying();
      // `initial` stands in for the first fetch only while it is fresh; once
      // the caller has been disabled, enabling it again fetches.
      skipInitialFetch.current = false;
      return;
    }
    // Under React StrictMode the simulated remount fetches anyway — one extra
    // GET in development, harmless.
    if (skipInitialFetch.current) {
      skipInitialFetch.current = false;
    } else {
      void load();
    }
    return stopAttempt;
  }, [enabled, refreshKey, load, stopAttempt, stopRetrying]);

  // Unmount ends everything, including attempts started by `refetch()` while
  // disabled, and releases the toast.
  useEffect(() => stopRetrying, [stopRetrying]);

  return { license, refetch: load };
}
