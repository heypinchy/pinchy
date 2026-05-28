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

class RestartState extends EventEmitter {
  isRestarting = false;
  triggeredAt: number | null = null;
  private autoClearTimer: ReturnType<typeof setTimeout> | null = null;

  notifyRestart() {
    this.isRestarting = true;
    this.triggeredAt = Date.now();
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
    if (this.autoClearTimer) {
      clearTimeout(this.autoClearTimer);
      this.autoClearTimer = null;
    }
    this.emit("ready");
  }
}

// Singleton via globalThis so server.ts and Next.js API routes share the same instance
const g = globalThis as unknown as Record<symbol, RestartState>;
export const restartState: RestartState = g[KEY] ?? (g[KEY] = new RestartState());
