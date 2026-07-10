/**
 * Unit tests for `SessionPokeBridge` — the heart of multi-device live-sync Lane B.
 *
 * It owns the refcounted per-session upstream `sessions.messages.subscribe` and,
 * on a finished message, fans a BODY-FREE "poke" out to every device subscribed
 * to that session. Two security-critical invariants pinned here:
 *  - the poke NEVER carries (or even reads) the message body — a mis-routed poke
 *    can leak at most "a session changed", never content;
 *  - routing uses the SERVER-subscribed key, not the untrusted `payload.sessionKey`.
 */
import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import { SessionSubscribers } from "@/server/session-subscribers";
import { SessionPokeBridge } from "@/server/session-poke-bridge";

function fakeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

// A fake upstream `subscribe` that records calls and lets the test drive the
// handler, simulating Gateway events.
function fakeUpstream() {
  const calls: { key: string; handler: (event: unknown) => void }[] = [];
  const unsubscribed: string[] = [];
  const subscribe = async (key: string, handler: (event: unknown) => void) => {
    calls.push({ key, handler });
    return { unsubscribe: async () => void unsubscribed.push(key) };
  };
  const emit = (key: string, event: unknown) => {
    for (const c of calls.filter((c) => c.key === key)) c.handler(event);
  };
  return { subscribe, emit, calls, unsubscribed };
}

const KEY = "agent:a1:direct:u1";

describe("SessionPokeBridge", () => {
  it("opens exactly one upstream subscription per session and reuses it across sockets", async () => {
    const up = fakeUpstream();
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: () => {},
    });

    await bridge.join(KEY, fakeWs());
    await bridge.join(KEY, fakeWs());

    expect(up.calls.map((c) => c.key)).toEqual([KEY]); // one subscription, reused
  });

  it("fans a body-free poke to every subscriber on a finished message and NEVER reads the body", async () => {
    const up = fakeUpstream();
    const sent: { ws: WebSocket; frame: unknown }[] = [];
    const subs = new SessionSubscribers();
    const bridge = new SessionPokeBridge({
      subs,
      subscribe: up.subscribe,
      send: (ws, frame) => void sent.push({ ws, frame }),
    });
    const a = fakeWs();
    const b = fakeWs();
    await bridge.join(KEY, a);
    await bridge.join(KEY, b);

    // A Gateway session.message whose body throws if anyone touches it.
    const payload: Record<string, unknown> = { sessionKey: KEY, messageId: "m7", messageSeq: 42 };
    Object.defineProperty(payload, "message", {
      enumerable: true,
      get() {
        throw new Error("body must never be read in the poke path");
      },
    });
    up.emit(KEY, { event: "session.message", payload });

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.ws)).toEqual(expect.arrayContaining([a, b]));
    expect(sent[0].frame).toEqual({ type: "poke", sessionKey: KEY, messageId: "m7", seq: 42 });
  });

  it("routes by the server-subscribed key, ignoring a spoofed payload.sessionKey", async () => {
    const up = fakeUpstream();
    const sent: { ws: WebSocket; frame: unknown }[] = [];
    const subs = new SessionSubscribers();
    const bridge = new SessionPokeBridge({
      subs,
      subscribe: up.subscribe,
      send: (ws, frame) => void sent.push({ ws, frame }),
    });
    const victim = fakeWs();
    await bridge.join("agent:a1:direct:victim", victim);

    // Event arrives on the victim's subscription but its payload claims another key.
    up.emit("agent:a1:direct:victim", {
      event: "session.message",
      payload: { sessionKey: "agent:a1:direct:attacker", messageId: "m1", messageSeq: 1 },
    });

    // The poke is routed to the victim's own socket (the subscribed key), and the
    // frame carries the trusted key — never the attacker-supplied one.
    expect(sent).toHaveLength(1);
    expect(sent[0].ws).toBe(victim);
    expect(sent[0].frame).toMatchObject({ sessionKey: "agent:a1:direct:victim" });
  });

  it("does NOT poke on wordwise 'agent' delta events (those are Lane A)", async () => {
    const up = fakeUpstream();
    const sent: unknown[] = [];
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: (_ws, frame) => void sent.push(frame),
    });
    await bridge.join(KEY, fakeWs());

    up.emit(KEY, {
      event: "agent",
      payload: { sessionKey: KEY, stream: "assistant", data: { delta: "hi" } },
    });

    expect(sent).toHaveLength(0);
  });

  it("closes the upstream subscription when the last socket leaves", async () => {
    const up = fakeUpstream();
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: () => {},
    });
    const a = fakeWs();
    const b = fakeWs();
    await bridge.join(KEY, a);
    await bridge.join(KEY, b);

    await bridge.leave(KEY, a);
    expect(up.unsubscribed).toEqual([]); // b still there
    await bridge.leave(KEY, b);
    expect(up.unsubscribed).toEqual([KEY]); // last one out closes it
  });

  it("view() makes a socket exclusively subscribe to one session, leaving prior ones", async () => {
    const up = fakeUpstream();
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: () => {},
    });
    const a = fakeWs();

    await bridge.view(KEY, a);
    await bridge.view(`${KEY}:c2`, a); // user switches the open chat

    expect(up.calls.map((c) => c.key)).toEqual([KEY, `${KEY}:c2`]);
    expect(up.unsubscribed).toEqual([KEY]); // the prior chat's upstream closed
  });

  it("view() to the same session is stable — no churn on a history refresh", async () => {
    const up = fakeUpstream();
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: () => {},
    });
    const a = fakeWs();

    await bridge.view(KEY, a);
    await bridge.view(KEY, a); // e.g. a reconnect/poke-driven history refresh

    expect(up.calls.map((c) => c.key)).toEqual([KEY]); // not re-subscribed
    expect(up.unsubscribed).toEqual([]);
  });

  it("on disconnect closes only the subscriptions the socket was alone in", async () => {
    const up = fakeUpstream();
    const bridge = new SessionPokeBridge({
      subs: new SessionSubscribers(),
      subscribe: up.subscribe,
      send: () => {},
    });
    const a = fakeWs(); // alone in c2, shares the base key with b
    const b = fakeWs();
    await bridge.join(KEY, a);
    await bridge.join(`${KEY}:c2`, a);
    await bridge.join(KEY, b);

    await bridge.disconnect(a);

    expect(up.unsubscribed).toEqual([`${KEY}:c2`]); // base key still has b
  });
});
