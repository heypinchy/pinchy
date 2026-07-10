/**
 * Unit tests for the `SessionSubscribers` registry (multi-device live-sync, Lane B).
 *
 * Why this exists: `ActiveRuns.listeners` only holds sockets while a run is in
 * flight and a client actively joined it — so an idle second device of the same
 * user never receives anything. `SessionSubscribers` is the PERSISTENT
 * per-sessionKey → socket-set map that lets Pinchy fan a body-free "poke" out to
 * every connected device of a user the moment any source changes that session.
 *
 * Two invariants this suite pins:
 *  - isolation: a socket added for one sessionKey never appears under another
 *    key (the structural half of the cross-user-leak story; the auth gate that
 *    decides WHICH key a socket may join lives in the client-router wiring).
 *  - leak-free teardown: removing a socket prunes it from every bucket it was in
 *    via a reverse index, so a closed socket is never a GC root and never gets a
 *    stale poke.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import { SessionSubscribers } from "@/server/session-subscribers";

// Identity is all the registry cares about — no real ws needed.
function fakeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

describe("SessionSubscribers", () => {
  let subs: SessionSubscribers;

  beforeEach(() => {
    subs = new SessionSubscribers();
  });

  describe("add / socketsFor", () => {
    it("returns exactly the sockets added for a sessionKey, isolated from other keys", () => {
      const a = fakeWs();
      const b = fakeWs();
      const other = fakeWs();

      subs.add("agent:a1:direct:u1", a);
      subs.add("agent:a1:direct:u1", b);
      subs.add("agent:a1:direct:u2", other); // different user → different key

      const sockets = subs.socketsFor("agent:a1:direct:u1");
      expect(sockets).toContain(a);
      expect(sockets).toContain(b);
      expect(sockets).not.toContain(other);
      expect(sockets).toHaveLength(2);

      // The other user's key only ever holds its own socket.
      expect(subs.socketsFor("agent:a1:direct:u2")).toEqual([other]);
      // An unknown key has no sockets.
      expect(subs.socketsFor("agent:a1:direct:u3")).toEqual([]);
    });
  });

  describe("refcount signalling", () => {
    it("reports the FIRST socket for a session so the caller can open the upstream subscription", () => {
      const a = fakeWs();
      const b = fakeWs();

      expect(subs.add("agent:a1:direct:u1", a)).toEqual({ firstForSession: true });
      expect(subs.add("agent:a1:direct:u1", b)).toEqual({ firstForSession: false });
    });

    it("re-adding the same socket is idempotent and not a first-join", () => {
      const a = fakeWs();

      expect(subs.add("agent:a1:direct:u1", a)).toEqual({ firstForSession: true });
      expect(subs.add("agent:a1:direct:u1", a)).toEqual({ firstForSession: false });
      expect(subs.socketsFor("agent:a1:direct:u1")).toEqual([a]);
    });
  });

  describe("removeFromSession (single-session leave, e.g. chat switch)", () => {
    it("reports the LAST socket leaving a session and deletes the now-empty bucket", () => {
      const a = fakeWs();
      const b = fakeWs();
      subs.add("agent:a1:direct:u1", a);
      subs.add("agent:a1:direct:u1", b);

      expect(subs.removeFromSession("agent:a1:direct:u1", a)).toEqual({ lastForSession: false });
      expect(subs.removeFromSession("agent:a1:direct:u1", b)).toEqual({ lastForSession: true });
      expect(subs.socketsFor("agent:a1:direct:u1")).toEqual([]);
    });

    it("is a no-op for a socket or key that is not subscribed", () => {
      const a = fakeWs();
      expect(subs.removeFromSession("agent:a1:direct:u1", a)).toEqual({ lastForSession: false });
    });
  });

  describe("removeSocket (full teardown on close AND error)", () => {
    it("prunes the socket from every bucket via the reverse index and returns the keys that emptied", () => {
      const a = fakeWs(); // subscribed to two of its own sessions
      const b = fakeWs(); // shares one session with a
      subs.add("agent:a1:direct:u1", a);
      subs.add("agent:a1:direct:u1:c2", a); // a second chat of the same user
      subs.add("agent:a1:direct:u1", b);

      const emptied = subs.removeSocket(a);

      // `a` is gone everywhere — never a GC root, never reached by a later poke.
      expect(subs.socketsFor("agent:a1:direct:u1")).toEqual([b]);
      expect(subs.socketsFor("agent:a1:direct:u1:c2")).toEqual([]);
      // Only the bucket where `a` was alone emptied → caller closes that upstream sub.
      expect(emptied).toEqual(["agent:a1:direct:u1:c2"]);
    });

    it("returns an empty list for an unknown socket", () => {
      expect(subs.removeSocket(fakeWs())).toEqual([]);
    });
  });

  describe("sessionKeysFor (reverse-index read, used by view())", () => {
    it("returns the keys a socket is currently subscribed to, empty for an unknown socket", () => {
      const a = fakeWs();
      subs.add("agent:a1:direct:u1", a);
      subs.add("agent:a1:direct:u1:c2", a);

      expect(subs.sessionKeysFor(a).sort()).toEqual([
        "agent:a1:direct:u1",
        "agent:a1:direct:u1:c2",
      ]);
      expect(subs.sessionKeysFor(fakeWs())).toEqual([]);
    });
  });
});
