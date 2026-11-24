/**
 * How the server tells an open chat tab that its account was deactivated, and
 * what the tab does about it. Shared by both sides of the socket — the server
 * (`server/user-sockets.ts`) and the browser (`hooks/use-ws-runtime.ts`) — so
 * this module stays import-free: a Client Component imports it.
 */

/** Application close code (RFC 6455 reserves 4000–4999 for these). */
export const ACCOUNT_DEACTIVATED_CLOSE_CODE = 4403;

/**
 * Error-frame code sent just before the close. The `policy_` prefix is what
 * the tab already reads as "nothing to retry": no Retry button, and a pending
 * wait for a history frame ends instead of running into the history timeout.
 */
export const ACCOUNT_DEACTIVATED_ERROR_CODE = "policy_account_deactivated";

/**
 * Leave the app for the login page — where an expired session ends up too.
 * The session rows are gone, so there is nothing left to reconnect with, and
 * the login page tells a deactivated account it can't sign in. A full page
 * load rather than a router push: everything client-side belongs to a session
 * that no longer exists.
 */
export function leaveDeactivatedAccount(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load on purpose, see above
  window.location.assign("/login");
}

/**
 * A tab whose socket was already closed when the account was deactivated —
 * hidden past its grace period, or mid-reconnect — never receives the 4403.
 * Its reconnects then fail the upgrade's session lookup (HTTP 401, which the
 * browser reports only as close 1006, indistinguishable from a server that is
 * down). After this many failed reconnects in a row the tab asks whether it
 * still has a session at all, and leaves for /login if it doesn't.
 */
export const SESSION_CHECK_AFTER_FAILED_RECONNECTS = 2;

/**
 * True only when Pinchy positively says this browser has no session:
 * Better Auth's `get-session` answers 200 with `null` then. Anything else —
 * a network error, a 5xx from a restarting server, an unreadable body — is
 * not evidence of a lost session, and answers false so the tab keeps its
 * ordinary reconnect backoff.
 */
export async function sessionIsGone(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/get-session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return false;
    return (await res.json()) === null;
  } catch {
    return false;
  }
}
