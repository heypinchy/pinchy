#!/usr/bin/env node
// Approve the *live* OpenClaw device-pairing request for Pinchy — once per call.
//
// Why this exists (the setup-wizard E2E flake):
// Pinchy connects to the gateway from a non-loopback container IP, so OpenClaw
// requires operator-side device pairing. While that pairing is pending, Pinchy
// keeps reconnecting (exponential backoff, maxReconnectAttempts: Infinity), and
// *every* reconnect makes OpenClaw mint a fresh pairing requestId, superseding
// the previous one.
//
// `openclaw devices approve --latest` is preview-only: it prints the pending
// requestId and exits 1 *without* approving, so we must approve with a second,
// explicit `openclaw devices approve <id>` call. Each call loads the full
// plugin system (seconds). The old bash loop discovered the id in one call and
// approved it in a *separate* call, then slept 5 s before retrying — leaving a
// multi-second window in which a reconnect could churn the id. The explicit
// approve then referenced a requestId the gateway no longer had pending and was
// rejected with INVALID_REQUEST "unknown requestId" (or "device pairing
// approval denied" on the operator.admin scope-upgrade round). OpenClaw's CLI
// has a same-device-replacement recovery, but it only engages for errors whose
// message contains "pairing required" — not for these two — so the approve just
// failed and the device could stay unapproved long enough that Pinchy never
// connected within the wizard's settle/health budget → E2E timeout.
//
// This script collapses discover+approve into one process and, on a stale-id
// rejection, re-discovers and re-approves *immediately* (a tight bounded retry)
// instead of losing a whole ~13 s outer tick — so it converges on whatever
// request is actually pending right now. The bash outer loop in
// start-openclaw.sh still owns cadence, the token gate, the connected-signal
// stop condition, and the overall pairing safety cap.
//
// Covered by config/__tests__/auto-approve-once.test.mjs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bounded burst per invocation: re-discover + re-approve a handful of times so
// a couple of reconnect-driven requestId rotations are absorbed within a single
// tick, then hand back to the outer loop. The outer loop in start-openclaw.sh
// owns the overall pairing deadline; this only caps one tick's work. Tunable
// via env.
const DEFAULT_MAX_ATTEMPTS =
  Number(process.env.PINCHY_APPROVE_MAX_ATTEMPTS) || 6;

// Per-CLI-call timeout. Each `openclaw devices` invocation loads the full plugin
// system, so allow generous headroom — but never block the tick forever on a
// stalled call (a hung discover/approve would otherwise wedge the whole burst).
const CLI_TIMEOUT_MS =
  Number(process.env.PINCHY_APPROVE_CLI_TIMEOUT_MS) || 30000;

const SIGNAL_PATH =
  process.env.PINCHY_DEVICE_APPROVED_SIGNAL ||
  "/root/.openclaw/pinchy-device-approved";

/**
 * Extract the pending pairing requestId from `openclaw devices approve --latest`
 * output. Prefers the structured `--json` shape ({ selected: { requestId } });
 * falls back to the human-readable "openclaw devices approve <id>" hint. Returns
 * null when nothing is pending or the id can't be found.
 */
export function parseLatestRequestId(output) {
  if (!output) return null;
  const text = String(output);
  let id = null;
  try {
    id = JSON.parse(text)?.selected?.requestId ?? null;
  } catch {
    // Not JSON — fall through to the text-hint parser below.
  }
  if (typeof id === "string" && id.trim()) return id.trim();
  // Fallback: the human-readable "openclaw devices approve <id>" hint, which
  // also appears as `approveCommand` inside the --json payload.
  const match = text.match(/openclaw devices approve\s+([A-Za-z0-9_=-]+)/);
  return match ? match[1] : null;
}

/**
 * Discover and approve the currently-pending device-pairing request, retrying
 * on stale-id rejections by re-discovering the live requestId.
 *
 * @param {object} deps
 * @param {(args: string[]) => {code: number, stdout: string, stderr: string}} deps.exec
 *        Runs `openclaw <args>` and returns its result.
 * @param {(msg: string) => void} [deps.log]
 * @param {() => boolean} [deps.isDone] Returns true once Pinchy has connected.
 * @param {number} [deps.maxAttempts]
 * @returns {{outcome: "approved"|"no-pending"|"exhausted"|"done", requestId: string|null}}
 */
export function approveLatestOnce({
  exec,
  log = () => {},
  isDone = () => false,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  let attempts = 0;
  let lastId = null;
  while (attempts < maxAttempts) {
    if (isDone()) return { outcome: "done", requestId: lastId };

    const latest = exec(["devices", "approve", "--latest", "--json"]);
    const id =
      parseLatestRequestId(latest?.stdout) ??
      parseLatestRequestId(latest?.stderr);
    if (!id) return { outcome: "no-pending", requestId: lastId };

    lastId = id;
    attempts += 1;

    const approve = exec(["devices", "approve", id, "--json"]);
    if (approve && approve.code === 0) {
      log(`approved device pairing request ${id}`);
      return { outcome: "approved", requestId: id };
    }

    const detail =
      (approve?.stderr || approve?.stdout || "").trim() || "no detail";
    log(`approve of ${id} failed (${detail}); re-discovering live request`);
  }
  return { outcome: "exhausted", requestId: lastId };
}

function realExec(args) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
  // A timeout (or signal kill) leaves status === null; map any non-numeric exit
  // to a failure so approveLatestOnce re-discovers rather than treating it as a
  // successful approve.
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function main() {
  const result = approveLatestOnce({
    exec: realExec,
    log: (msg) => console.log(`[auto-approve] ${msg}`),
    isDone: () => existsSync(SIGNAL_PATH),
  });
  if (result.outcome === "exhausted") {
    console.log(
      `[auto-approve] no approval landed this tick (last id ${result.requestId ?? "none"}); outer loop will retry`,
    );
  }
  // Always exit 0: the bash outer loop owns cadence and the connected-signal
  // success check, so a nonzero exit here would only be swallowed by `|| true`.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
