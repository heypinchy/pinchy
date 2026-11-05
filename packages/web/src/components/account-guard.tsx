"use client";

import { useEffect } from "react";
import { claimAccount, navigation, watchAccount } from "@/lib/account-switch";

/**
 * Keeps this tab's client state to the signed-in person (#1286). On load it
 * claims the browser's Pinchy storage, reloading once if it had to wipe what
 * someone else left; afterwards it reloads when another tab signs out or signs
 * in as somebody else.
 */
export function AccountGuard({ userId }: { userId: string }) {
  useEffect(() => {
    if (claimAccount(userId)) navigation.reload();
    return watchAccount(userId);
  }, [userId]);
  return null;
}
