import { authClient } from "@/lib/auth-client";
import {
  CACHE_NAME as SHARE_TARGET_CACHE_NAME,
  sweepStaleShares,
} from "@/lib/share-target/share-cache";

/**
 * Signing out and signing in on a shared browser (#1286).
 *
 * Pinchy keeps per-person state in the browser without a user in the key:
 * composer drafts, the draft ids staged uploads hang off, and the last-chat
 * pointer live in localStorage under `pinchy:`, a "Save as instruction"
 * handoff in sessionStorage, and module-level caches (the chat list, in-memory
 * drafts) survive any client-side navigation. A file shared into the
 * installed app and never sent waits in the service worker's `share-target`
 * cache. A `router.push` between two accounts therefore shows the next person
 * what the last one left behind.
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
const SIGNED_OUT_PREFIX = "signed-out:";
// How old a share may be and still be kept at sign-in. Nothing tells who made
// a share, so only one young enough to belong to the person at the keyboard,
// sent to the login page by sharing it, survives.
const RECENT_SHARE_MS = 10 * 60 * 1000;

// The agent settings page sets window.onbeforeunload while it has unsaved
// edits. On an account switch that "Leave site?" prompt must not get a say:
// "Stay" would keep the previous person's page alive after their session.
function dropUnloadPrompt(): void {
  window.onbeforeunload = null;
}

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
// The account record itself is left alone: callers overwrite it, and removing
// it first would let another tab read "nobody" in between.
function wipePinchyStorage(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PINCHY_PREFIX) && key !== ACCOUNT_KEY) localStorage.removeItem(key);
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

function forgetAccount(): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // ignore
  }
}

// Async, so callers wait for it before the page moves on: a navigation can
// cut an unfinished Cache Storage call short.
async function forgetShares(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(SHARE_TARGET_CACHE_NAME);
  } catch {
    // ignore
  }
}

async function keepRecentShares(): Promise<void> {
  try {
    await sweepStaleShares(RECENT_SHARE_MS);
  } catch {
    // ignore
  }
}

/** The account this browser's Pinchy storage was last claimed for, if readable. */
export function recordedAccount(): string | null {
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
 * was recorded (or nobody), then records them. The wipe and the record happen
 * synchronously, before the returned promise first waits, so a caller in a
 * render can rely on clean storage for everything rendered after it.
 */
export async function claimAccount(userId: string): Promise<void> {
  const previous = recordedAccount();
  if (previous === userId) return;
  wipePinchyStorage();
  recordAccount(userId);
  // After a sign-out the earlier shares are already gone, so any share there
  // now was made while nobody was signed in. Keep a recent one for the person
  // signing in; when someone else's session merely expired, drop them all.
  if (previous?.startsWith(SIGNED_OUT_PREFIX)) await keepRecentShares();
  else await forgetShares();
}

/**
 * Signs out, wipes this browser's Pinchy storage, and reloads into the login
 * page. A sign-out that is refused or never reaches the server still wipes: on
 * a shared browser the next person starting clean matters more than the
 * outcome of the request.
 */
export async function leaveAccount(): Promise<void> {
  try {
    await authClient.signOut();
  } catch {
    // Offline or a restarting server; wipe and leave all the same.
  }
  wipePinchyStorage();
  // Always a new value, so every other tab gets a storage event.
  recordAccount(`${SIGNED_OUT_PREFIX}${Date.now()}`);
  await forgetShares();
  dropUnloadPrompt();
  navigation.assign("/login");
}

/** Enters the account that just signed in, with a full load to `target`. */
export async function enterAccount(userId: string | undefined, target: string): Promise<void> {
  if (!userId) {
    wipePinchyStorage();
    forgetAccount();
    await forgetShares();
  } else if (recordedAccount() === userId) await keepRecentShares();
  else await claimAccount(userId);
  dropUnloadPrompt();
  navigation.assign(target);
}

/**
 * Reloads this tab because the browser now belongs to someone else. Clears the
 * tab's own sessionStorage first: a reload keeps it, and no other tab can.
 */
export function reloadForAccountChange(): void {
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  dropUnloadPrompt();
  navigation.reload();
}

/** Reloads this tab when another tab records a different account. Returns the unsubscribe. */
export function watchAccount(userId: string): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCOUNT_KEY && event.newValue !== userId) reloadForAccountChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
