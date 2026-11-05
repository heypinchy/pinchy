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
 *
 * Other open tabs share the cookie but not their memory: a second tab of the
 * previous person would keep their chat list and drafts, and write a draft
 * back into storage after the wipe. `pinchy:account` is therefore written on
 * every switch (a `signed-out:` marker on leaving), and `watchAccount` reloads
 * any tab that sees it change to someone else.
 */

const PINCHY_PREFIX = "pinchy:";
const ACCOUNT_KEY = `${PINCHY_PREFIX}account`;

/** Indirection so tests can observe the full-page navigation jsdom cannot perform. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  reload(): void {
    window.location.reload();
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

function recordAccount(value: string): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, value);
  } catch {
    // ignore
  }
}

/**
 * Makes this browser's storage belong to `userId`: wipes it if someone else
 * was recorded (or nobody), then records them. Returns whether it wiped, in
 * which case a tab that already rendered from that storage should reload.
 */
export function claimAccount(userId: string): boolean {
  const wiped = previousAccount() !== userId;
  if (wiped) wipePinchyStorage();
  recordAccount(userId);
  return wiped;
}

/**
 * Signs out, wipes this browser's Pinchy storage, and reloads into the login
 * page. A sign-out the server refuses still wipes: on a shared browser the
 * next person starting clean matters more than the outcome of the request.
 */
export async function leaveAccount(): Promise<void> {
  await authClient.signOut();
  wipePinchyStorage();
  // Always a new value, so every other tab gets a storage event.
  recordAccount(`signed-out:${Date.now()}`);
  navigation.assign("/login");
}

/** Enters the account that just signed in, with a full load to `target`. */
export function enterAccount(userId: string | undefined, target: string): void {
  if (userId) claimAccount(userId);
  else wipePinchyStorage();
  navigation.assign(target);
}

/** Reloads this tab when another tab records a different account. Returns the unsubscribe. */
export function watchAccount(userId: string): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCOUNT_KEY && event.newValue !== userId) navigation.reload();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
