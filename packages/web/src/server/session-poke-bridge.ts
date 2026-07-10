import type { WebSocket } from "ws";
import type { SessionSubscribers } from "@/server/session-subscribers";

/** Handle returned by an upstream subscription; `unsubscribe` is teardown-safe. */
export interface UpstreamSubscription {
  unsubscribe: () => Promise<void> | void;
}

/**
 * Opens a per-session upstream subscription (wraps
 * `openclawClient.sessions.subscribeMessages`). The handler is invoked for every
 * Gateway event of that session — `subscribeMessages` matches both the caller
 * key and the Gateway's canonical key, so canonicalization can't silently drop.
 */
export type SubscribeUpstream = (
  sessionKey: string,
  handler: (event: unknown) => void
) => Promise<UpstreamSubscription>;

/** Send a frame to one browser socket (readyState-gated by the caller). */
export type SendToSocket = (ws: WebSocket, frame: unknown) => void;

/** The only thing that crosses the wire to an idle device: a content-free signal. */
interface PokeFrame {
  type: "poke";
  sessionKey: string;
  messageId: string | undefined;
  seq: number | undefined;
}

/**
 * Multi-device live-sync, Lane B. Owns a refcounted per-session upstream
 * subscription and fans a BODY-FREE poke out to every device subscribed to that
 * session whenever a finished message lands. Security model: the poke carries no
 * content and is routed by the SERVER-subscribed key (never the untrusted
 * `payload.sessionKey`), so a mis-routed poke can leak at most "a session
 * changed" — the device then re-pulls authoritative state through the normal
 * cookie-authorized history path.
 *
 * Process-singleton in production (the upstream subscriptions live on the one
 * shared OpenClawClient and are refcounted across every ClientRouter/socket of a
 * session). Tests inject `subscribe`/`send`.
 */
export class SessionPokeBridge {
  private readonly subs: SessionSubscribers;
  private readonly subscribe: SubscribeUpstream;
  private readonly send: SendToSocket;
  private readonly upstream = new Map<string, UpstreamSubscription>();
  private readonly opening = new Set<string>();

  constructor(deps: {
    subs: SessionSubscribers;
    subscribe: SubscribeUpstream;
    send: SendToSocket;
  }) {
    this.subs = deps.subs;
    this.subscribe = deps.subscribe;
    this.send = deps.send;
  }

  /**
   * A socket now EXCLUSIVELY views `sessionKey` — the mirror of
   * `ActiveRuns.removeListenerFromAll` + `addListener`. Leaves any other session
   * it was in (closing those upstreams on last-leave) and joins this one. Stable
   * when called repeatedly for the same key (e.g. a poke-driven history refresh):
   * no upstream churn. This is the method `handleHistory` calls.
   */
  async view(sessionKey: string, ws: WebSocket): Promise<void> {
    for (const prior of this.subs.sessionKeysFor(ws)) {
      if (prior !== sessionKey) await this.leave(prior, ws);
    }
    await this.join(sessionKey, ws);
  }

  /** A socket starts viewing `sessionKey`. Opens the upstream sub on first join. */
  async join(sessionKey: string, ws: WebSocket): Promise<void> {
    const { firstForSession } = this.subs.add(sessionKey, ws);
    if (firstForSession) await this.openUpstream(sessionKey);
  }

  /** A socket stops viewing `sessionKey` (chat switch). Closes on last leave. */
  async leave(sessionKey: string, ws: WebSocket): Promise<void> {
    const { lastForSession } = this.subs.removeFromSession(sessionKey, ws);
    if (lastForSession) await this.closeUpstream(sessionKey);
  }

  /** A socket disconnected (close OR error). Closes every sub it was alone in. */
  async disconnect(ws: WebSocket): Promise<void> {
    for (const sessionKey of this.subs.removeSocket(ws)) {
      await this.closeUpstream(sessionKey);
    }
  }

  private async openUpstream(sessionKey: string): Promise<void> {
    if (this.upstream.has(sessionKey) || this.opening.has(sessionKey)) return;
    this.opening.add(sessionKey);
    try {
      const handle = await this.subscribe(sessionKey, (event) =>
        this.onUpstreamEvent(sessionKey, event)
      );
      // Everyone may have left while the async subscribe was in flight.
      if (this.subs.socketsFor(sessionKey).length === 0) {
        await handle.unsubscribe();
      } else {
        this.upstream.set(sessionKey, handle);
      }
    } finally {
      this.opening.delete(sessionKey);
    }
  }

  private async closeUpstream(sessionKey: string): Promise<void> {
    const handle = this.upstream.get(sessionKey);
    if (!handle) return;
    this.upstream.delete(sessionKey);
    await handle.unsubscribe();
  }

  private onUpstreamEvent(sessionKey: string, event: unknown): void {
    const e = event as { event?: string; payload?: Record<string, unknown> };
    // Only a finished/visible message pokes. Wordwise 'agent' deltas belong to
    // Lane A (the firing device's own stream) and must not trigger a re-pull.
    if (e.event !== "session.message") return;

    const payload = e.payload ?? {};
    const frame: PokeFrame = {
      type: "poke",
      // SERVER-subscribed key — the trust anchor. Never payload.sessionKey.
      sessionKey,
      messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
      seq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
    };
    for (const ws of this.subs.socketsFor(sessionKey)) this.send(ws, frame);
  }
}
