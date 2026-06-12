/**
 * Seat-limit grace semantics from the pricing concept (§ 5): soft cap with a
 * 20% grace window so a new hire never waits on procurement. Invites keep
 * working up to floor(1.2 * maxUsers) seats; beyond that, only the invite
 * endpoint blocks — existing users are never deactivated or degraded.
 *
 * Pure function, shared by the API route and the client UI.
 */

export interface SeatPressure {
  /** No seat cap at all (maxUsers 0 — community or uncapped key). */
  unlimited: boolean;
  /** More seats in use than licensed (inside or beyond the grace window). */
  overCap: boolean;
  /** Whether one more invite may be created. */
  inviteAllowed: boolean;
  /** floor(1.2 * maxUsers), or null when unlimited. */
  graceCap: number | null;
}

export function evaluateSeatPressure(used: number, maxUsers: number): SeatPressure {
  if (maxUsers <= 0) {
    return { unlimited: true, overCap: false, inviteAllowed: true, graceCap: null };
  }
  const graceCap = Math.floor(maxUsers * 1.2);
  return {
    unlimited: false,
    overCap: used > maxUsers,
    inviteAllowed: used < graceCap,
    graceCap,
  };
}
