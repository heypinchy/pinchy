/**
 * Is a TCP port free right now?
 *
 * Kept out of `worktree-env.mjs` so it can be tested against real sockets —
 * the whole difficulty here is in the OS's binding rules, which a mock would
 * simply restate incorrectly. See port-probe.test.mjs.
 */
import { createServer } from "node:net";

function canBind(port, host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * Free means: we can bind it on the wildcard address AND on loopback.
 *
 * Both checks are needed, and they must run one after the other:
 *
 *   - Wildcard alone misses a loopback-only listener. On macOS `SO_REUSEADDR`
 *     (which Node sets) lets `0.0.0.0:PORT` bind while `127.0.0.1:PORT` is
 *     held — and loopback is exactly how the dev compose publishes Pinchy.
 *   - Concurrently would make the probe collide with itself: on Linux a
 *     wildcard and a loopback bind on one port conflict, so every port would
 *     come back busy.
 */
export async function probePort(port) {
  if (!(await canBind(port, "0.0.0.0"))) return false;
  return canBind(port, "127.0.0.1");
}

/** The subset of `candidates` that is free, probed concurrently. */
export async function freePorts(candidates) {
  const results = await Promise.all(candidates.map(probePort));
  return new Set(candidates.filter((_, i) => results[i]));
}
