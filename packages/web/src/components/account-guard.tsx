"use client";

import { useEffect } from "react";
import { claimAccount, navigation, recordedAccount, watchAccount } from "@/lib/account-switch";

/**
 * Keeps this tab's client state to the signed-in person (#1286). On load it
 * claims the browser's Pinchy storage, reloading once if it had to wipe what
 * someone else left; afterwards it reloads when another tab signs out or signs
 * in as somebody else, or when a page restored from the back/forward cache
 * finds that someone else has been recorded since.
 */
export function AccountGuard({ userId }: { userId: string }) {
  useEffect(() => {
    let active = true;
    void claimAccount(userId).then((wiped) => {
      if (wiped && active) navigation.reload();
    });
    // A page restored from the back/forward cache re-runs no effect and missed
    // every storage event while it was frozen, so it checks again when shown.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && recordedAccount() !== userId) navigation.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    const stopWatching = watchAccount(userId);
    return () => {
      active = false;
      window.removeEventListener("pageshow", onPageShow);
      stopWatching();
    };
  }, [userId]);
  return null;
}
