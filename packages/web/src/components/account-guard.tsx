"use client";

import { useEffect, useState } from "react";
import {
  claimAccount,
  recordedAccount,
  reloadForAccountChange,
  watchAccount,
} from "@/lib/account-switch";

/**
 * Keeps this tab's client state to the signed-in person (#1286).
 *
 * It wraps the app and claims the browser's Pinchy storage during its own
 * first render, before anything under it renders and reads that storage. That
 * order is the point: claiming later, in an effect, would find the keys the
 * page had just written and could not tell them from someone else's. A page
 * that got here through a full load holds no one else's in-memory state, so
 * the claim never needs a reload.
 *
 * Afterwards it reloads the tab when another tab signs out or signs in as
 * somebody else, and when a page restored from the back/forward cache finds
 * that someone else has been recorded since.
 */
export function AccountGuard({ userId, children }: { userId: string; children: React.ReactNode }) {
  useState(() => {
    if (typeof window !== "undefined") void claimAccount(userId);
    return null;
  });

  useEffect(() => {
    // A restored page re-runs no effect and missed every storage event while
    // it was frozen, so it checks again when shown.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && recordedAccount() !== userId) reloadForAccountChange();
    };
    window.addEventListener("pageshow", onPageShow);
    const stopWatching = watchAccount(userId);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      stopWatching();
    };
  }, [userId]);

  return children;
}
