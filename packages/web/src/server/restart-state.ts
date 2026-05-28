import { EventEmitter } from "events";

const KEY = Symbol.for("pinchy.restartState");

// Hard cap on how long the "restarting" overlay can stay up before we give
// up and clear it. Only used as a last-resort safety net for the case where
// OC decides the config change is hot-reloadable and never disconnects — in
// which case our disconnect+reconnect gate would otherwise wait forever.
// 10 min comfortably covers the worst legitimate deferred-restart window
// observed in production (OC waits for active agent runs before restarting,
// and runs can be several minutes).
const MAX_RESTART_AGE_MS = 10 * 60_000;
// How often the safety net re-checks once the initial window has lapsed.
const SAFETY_INTERVAL_MS = 60_000;

class RestartState extends EventEmitter {
  isRestarting = false;
  triggeredAt: number | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectSeenSinceRestart = false;

  notifyRestart() {
    this.isRestarting = true;
    this.triggeredAt = Date.now();
    this.disconnectSeenSinceRestart = false;
    this.emit("restarting");
    this.scheduleSafetyCheck();
  }

  // Wired to openclaw-node's "disconnected" event in server.ts. Records that
  // the WS dropped at least once since the last notifyRestart() — i.e. OC
  // really did go down to apply the change. Without this gate, a stale
  // reconnect event during a deferred-restart window would clear the state
  // prematurely (the "AUTO_CLEAR lies" bug fixed by #-the-PR-this-lives-in).
  notifyDisconnect() {
    if (this.isRestarting) this.disconnectSeenSinceRestart = true;
  }

  // Wired to openclaw-node's "connected" event in server.ts. Only flips ready
  // when we've already seen a disconnect since the restart was requested.
  notifyConnect() {
    if (!this.isRestarting) return;
    if (this.disconnectSeenSinceRestart) this.notifyReady();
  }

  notifyReady() {
    if (!this.isRestarting) return;
    this.isRestarting = false;
    this.triggeredAt = null;
    this.disconnectSeenSinceRestart = false;
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.emit("ready");
  }

  private scheduleSafetyCheck() {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      const age = this.triggeredAt ? Date.now() - this.triggeredAt : 0;
      if (age >= MAX_RESTART_AGE_MS) {
        this.notifyReady();
        return;
      }
      this.scheduleSafetyCheck();
    }, SAFETY_INTERVAL_MS);
  }
}

// Singleton via globalThis so server.ts and Next.js API routes share the same instance
const g = globalThis as unknown as Record<symbol, RestartState>;
export const restartState: RestartState = g[KEY] ?? (g[KEY] = new RestartState());
