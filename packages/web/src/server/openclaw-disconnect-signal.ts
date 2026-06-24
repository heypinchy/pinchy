import type { OpenClawClient } from "openclaw-node";

/**
 * A "the OpenClaw socket just dropped" notification that in-flight stream loops
 * race their iteration against. See `iterateUntilAborted` for why a dropped
 * socket would otherwise block a `for await` forever and leak the run's
 * heartbeat interval and ActiveRuns entry (#7).
 */
export interface DisconnectSignal {
  /** Resolves the next time OpenClaw disconnects. */
  whenDisconnected(): Promise<void>;
}

/**
 * The shared implementation: ONE listener on the OpenClaw client, fanned out to
 * every in-flight run via a single promise that re-arms on reconnect.
 *
 * Subscribing per-run instead would add a `disconnected` listener for every
 * concurrent chat — quickly tripping Node's MaxListenersExceededWarning under
 * load — and churn subscribe/unsubscribe on every turn. Keeping one listener
 * regardless of run count avoids both.
 */
export class OpenClawDisconnectSignal implements DisconnectSignal {
  private resolveCurrent: () => void = () => {};
  private current: Promise<void> = Promise.resolve();

  constructor(client: Pick<OpenClawClient, "on">) {
    this.arm();
    // openclaw-node fires "disconnected" on every failed reconnect attempt
    // (~1s); resolving the same already-settled promise again is a no-op, so
    // repeated events during one outage are harmless.
    client.on("disconnected", () => this.resolveCurrent());
    // On reconnect, arm a fresh (unresolved) promise so a run started after the
    // outage doesn't immediately see an already-fired signal.
    client.on("connected", () => this.arm());
  }

  private arm(): void {
    this.current = new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
    });
  }

  whenDisconnected(): Promise<void> {
    return this.current;
  }
}

/**
 * A signal that never fires — the default for ClientRouter so tests and any
 * caller that doesn't wire a real signal keep the previous "drain to the
 * stream's natural end" behavior unchanged.
 */
export const NEVER_DISCONNECTS: DisconnectSignal = {
  whenDisconnected: () => new Promise<void>(() => {}),
};
