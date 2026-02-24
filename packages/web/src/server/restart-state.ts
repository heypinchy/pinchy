import { EventEmitter } from "events";

const KEY = Symbol.for("pinchy.restartState");

class RestartState extends EventEmitter {
  isRestarting = false;
  triggeredAt: number | null = null;

  notifyRestart() {
    this.isRestarting = true;
    this.triggeredAt = Date.now();
    this.emit("restarting");
  }

  notifyReady() {
    if (!this.isRestarting) return;
    this.isRestarting = false;
    this.triggeredAt = null;
    this.emit("ready");
  }
}

// Singleton via globalThis so server.ts and Next.js API routes share the same instance
const g = globalThis as unknown as Record<symbol, RestartState>;
export const restartState: RestartState = g[KEY] ?? (g[KEY] = new RestartState());
