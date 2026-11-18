/**
 * Is this port actually free?
 *
 * Tested against real sockets rather than a mock, because the bug this exists
 * to prevent lives entirely in the OS's binding rules:
 *
 *   - Probing only `0.0.0.0` misses a loopback-only listener. On macOS,
 *     `SO_REUSEADDR` (which Node sets) lets a wildcard bind succeed while
 *     `127.0.0.1:PORT` is held — so the probe called an occupied port free.
 *     That blind spot pointed straight at our own stacks, since the dev
 *     compose publishes Pinchy on `127.0.0.1:PORT`.
 *   - Probing both addresses AT ONCE is just as wrong, in the other
 *     direction: on Linux a wildcard bind and a loopback bind on the same port
 *     conflict, so the probe would collide with ITSELF and report every port
 *     busy. The two binds must be sequential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { probePort, freePorts } from "./port-probe.mjs";

/** Ask the OS for a port it considers free, then hand it back. */
function borrowFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function listen(port, host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(port, host, () => resolve(s));
  });
}

const close = (s) => new Promise((r) => s.close(r));

test("calls an unused port free", async () => {
  const port = await borrowFreePort();
  assert.equal(await probePort(port), true);
});

test("calls a port held on loopback only TAKEN", async () => {
  // The original defect: this returned true, and the worktree was handed a
  // port another stack was already serving on.
  const port = await borrowFreePort();
  const holder = await listen(port, "127.0.0.1");
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await close(holder);
  }
});

test("calls a port held on the wildcard address TAKEN", async () => {
  const port = await borrowFreePort();
  const holder = await listen(port, "0.0.0.0");
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await close(holder);
  }
});

test("does not collide with its own probe", async () => {
  // Guards the sequential-bind requirement: if the two binds ran at once, a
  // free port would come back busy on Linux and allocation would never
  // succeed there. Repeat to catch an order-dependent flake.
  const port = await borrowFreePort();
  for (let i = 0; i < 5; i++) {
    assert.equal(await probePort(port), true, `probe ${i} disagreed`);
  }
});

test("freePorts keeps the free ones and drops the taken ones", async () => {
  const free = await borrowFreePort();
  const taken = await borrowFreePort();
  const holder = await listen(taken, "127.0.0.1");
  try {
    const result = await freePorts([free, taken]);
    assert.ok(result.has(free), "free port missing from the set");
    assert.ok(!result.has(taken), "taken port must not be offered");
  } finally {
    await close(holder);
  }
});
