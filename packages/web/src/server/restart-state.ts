import { EventEmitter } from "events";

const KEY = Symbol.for("pinchy.restartState");

// Safety net: every notifyRestart() ships with the implicit contract that a
// corresponding notifyReady() fires via the OC reconnect handler in server.ts.
// But that contract leaks at the edges — OC may treat a file write as no-op
// (byte diff with no functional diff in its compare hash) and never restart,
// in which case notifyReady never arrives and isRestarting stays true forever,
// stranding the client overlay and any /api/health/openclaw poller. 60 s comfortably
// covers OC's worst-case container restart (~45 s including supervised lock recovery)
// without dragging tests through their full timeouts.
const AUTO_CLEAR_MS = 60_000;

// How long after the last notifyRestart() call a subsequent OC disconnect
// should re-show the overlay. OC's deferred restart (active-run drain) has
// been measured at up to ~3.5 min in production; 10 min gives a generous
// buffer while still filtering truly unrelated disconnects.
const DEFERRED_RESTART_WINDOW_MS = 10 * 60_000;

class RestartState extends EventEmitter {
  isRestarting = false;
  triggeredAt: number | null = null;
  // Persists through notifyReady() so notifyDisconnect() can detect a
  // deferred-restart disconnect that arrives after the ready handshake.
  private lastTriggeredAt: number | null = null;
  private autoClearTimer: ReturnType<typeof setTimeout> | null = null;

  notifyRestart() {
    this.isRestarting = true;
    this.triggeredAt = Date.now();
    this.lastTriggeredAt = this.triggeredAt;
    this.emit("restarting");

    if (this.autoClearTimer) clearTimeout(this.autoClearTimer);
    this.autoClearTimer = setTimeout(() => {
      this.autoClearTimer = null;
      this.notifyReady();
    }, AUTO_CLEAR_MS);
  }

  notifyReady() {
    if (!this.isRestarting) return;
    this.isRestarting = false;
    this.triggeredAt = null;
    // lastTriggeredAt is intentionally NOT cleared here — notifyDisconnect()
    // needs it to detect a deferred-restart disconnect that arrives after
    // this ready handshake.
    if (this.autoClearTimer) {
      clearTimeout(this.autoClearTimer);
      this.autoClearTimer = null;
    }
    this.emit("ready");
  }

  // Called by the OC disconnect handler in server.ts. If OC goes down within
  // DEFERRED_RESTART_WINDOW_MS of the last notifyRestart() and the overlay is
  // not already showing, re-fire notifyRestart() so the UI shows the overlay
  // for the actual restart (OC defers gateway restart until active runs drain).
  notifyDisconnect() {
    if (this.isRestarting) return; // overlay already showing
    if (this.lastTriggeredAt === null) return; // no restart ever triggered
    if (Date.now() - this.lastTriggeredAt > DEFERRED_RESTART_WINDOW_MS) return; // window expired
    this.notifyRestart();
  }
}

// Singleton via globalThis so server.ts and Next.js API routes share the same instance
const g = globalThis as unknown as Record<symbol, RestartState>;
export const restartState: RestartState = g[KEY] ?? (g[KEY] = new RestartState());
