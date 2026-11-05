import { authClient } from "@/lib/auth-client";

/**
 * Signing out and signing in on a shared browser (#1286).
 *
 * Pinchy keeps per-person state in the browser without a user in the key:
 * composer drafts, the draft ids staged uploads hang off, and the last-chat
 * pointer live in localStorage under `pinchy:`, a "Save as instruction"
 * handoff in sessionStorage, and module-level caches (the chat list, in-memory
 * drafts) survive any client-side navigation. A `router.push` between two
 * accounts therefore shows the next person what the last one left behind.
 *
 * So leaving an account wipes that storage and reloads the page, and entering
 * one does the same when someone else was signed in here last. The second half
 * covers a session that expired without anybody signing out; the same person
 * signing back in keeps their drafts.
 */

const PINCHY_PREFIX = "pinchy:";
const ACCOUNT_KEY = `${PINCHY_PREFIX}account`;

/** Indirection so tests can observe the full-page navigation jsdom cannot perform. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

// Storage can throw (Safari private mode, blocked site data). Wiping is a
// best effort and must never stand between a person and signing in or out.
function wipePinchyStorage(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PINCHY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
}

function previousAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Signs out, wipes this browser's Pinchy storage, and reloads into the login page. */
export async function leaveAccount(): Promise<void> {
  await authClient.signOut();
  wipePinchyStorage();
  navigation.assign("/login");
}

/** Enters the account that just signed in, with a full load to `target`. */
export function enterAccount(userId: string | undefined, target: string): void {
  if (!userId || previousAccount() !== userId) wipePinchyStorage();
  if (userId) {
    try {
      localStorage.setItem(ACCOUNT_KEY, userId);
    } catch {
      // ignore
    }
  }
  navigation.assign(target);
}
