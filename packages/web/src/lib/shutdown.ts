/**
 * Graceful-shutdown plumbing for the custom Next.js server.
 *
 * Registers SIGTERM/SIGINT handlers that run every supplied `stopFn`
 * (e.g. `stopUsagePoller`, `server.close`, OpenClaw client disconnect) in
 * order, then calls `exit`. Failures inside one stopFn must not prevent the
 * others from running — a broken shutdown step is not a reason to orphan
 * DB handles, timers, or network sockets.
 *
 * `exit` is injectable so tests don't actually terminate the process.
 */

type StopFn = () => void | Promise<void>;

export interface ShutdownOptions {
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
}

export function registerShutdownHandlers(
  stopFns: StopFn[],
  options: ShutdownOptions = {}
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? (["SIGTERM", "SIGINT"] as NodeJS.Signals[]);

  const handler = async (signal: NodeJS.Signals) => {
    console.log(`[pinchy] Received ${signal}, shutting down...`);
    for (const fn of stopFns) {
      try {
        await fn();
      } catch (err) {
        console.error("[pinchy] Shutdown handler error:", err instanceof Error ? err.message : err);
      }
    }
    exit(0);
  };

  for (const signal of signals) {
    process.on(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, handler);
    }
  };
}
