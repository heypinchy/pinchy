// packages/web/src/__tests__/lib/plugin-fetch-timeout-coverage.test.ts
//
// Every `fetch()` in the plugin sources must pass a `signal`.
//
// An unbounded fetch has no failure mode that looks like a bug: the call simply
// never returns. A Pinchy container mid-deploy, or a network blackhole that
// swallows packets without sending an RST, leaves the plugin waiting forever —
// and in pinchy-audit's `before_tool_call` hook that stalls every tool call of
// every agent, with nothing in any log naming the cause.
//
// The reason this is a guard and not a review note is the change that
// introduced it. That change added timeouts to 15 call sites and wrote, in a
// comment, that the mailbox providers "bound themselves separately (see
// graph-adapter.ts, gmail-adapter.ts, imap-adapter.ts)". gmail-adapter.ts did
// not: it talks through googleapis, whose transport documents `timeout` as "No
// timeout by default". The prose asserted coverage the code did not have, and
// nothing could contradict it. Same shape as AGENTS.md § "A Hand-Maintained
// List That Mirrors Code Will Be Wrong" — the one list with a guard is the one
// list that stays correct.
//
// Known limitations, stated plainly rather than left for a reader to assume
// away:
//
//   • It sees `fetch` and nothing else. A plugin that reaches the network
//     through another transport is invisible here — today that is
//     gmail-adapter.ts (googleapis/gaxios, bounded by its `timeout` option) and
//     imap-adapter.ts (imapflow, bounded by connectionTimeout/socketTimeout).
//     Neither can this guard confirm; both are covered by their own unit tests.
//   • It checks that a `signal` is passed, not that the signal is any good. A
//     `signal: AbortSignal.timeout(86_400_000)` passes. The value belongs to
//     review and to the per-call tests that assert it.
import { describe, it, expect } from "vitest";
import { findFetchCallSites, findPluginSourceFiles } from "./plugin-fetch-extraction";

// A call site that genuinely cannot take a signal would go here, keyed by
// "<repo-relative file>:<line>" with a reason. It is empty today, and a stale
// entry fails below — a verdict must not outlive its evidence.
const EXEMPT_CALL_SITES: Record<string, string> = {};

describe("plugin fetch timeout coverage", () => {
  const sites = findFetchCallSites(findPluginSourceFiles());

  it("finds a real corpus of fetch call sites", () => {
    // A walker that resolves nothing would pass every assertion below in
    // silence, which is how a coverage gate turns into decoration. The floor
    // sits under the count at the time of writing (16) with room for churn.
    expect(
      sites.length,
      "Found almost no fetch() calls in packages/plugins — the scan is broken, not the tree."
    ).toBeGreaterThanOrEqual(12);
  });

  it("resolves fetch through its aliases, not just the bare identifier", () => {
    // pinchy-web/web-fetch.ts reaches fetch as `httpFetch`, an alias of an
    // alias (`import { fetch as undiciFetch }` → `const httpFetch =
    // undiciFetch as ...`). A scan that only matched the literal `fetch(`
    // would report that file as clean while never having looked at it.
    const aliased = sites.filter((s) => s.callee !== "fetch");
    expect(
      aliased.length,
      "No aliased fetch call was resolved — check collectFetchAliases against web-fetch.ts."
    ).toBeGreaterThan(0);
  });

  it("passes a signal at every fetch call site", () => {
    const unbounded = sites
      .filter((s) => !s.bounded)
      .filter((s) => !(`${s.file}:${s.line}` in EXEMPT_CALL_SITES));

    expect(
      unbounded.map((s) => `${s.file}:${s.line} (${s.callee})`),
      [
        "These fetch() calls pass no `signal`, so a hung endpoint blocks them forever:",
        ...unbounded.map((s) => `  ${s.file}:${s.line} — ${s.callee}(…)`),
        "",
        "Add `signal: AbortSignal.timeout(MS)` to the init object. Pick a bound",
        "above the call's legitimate worst case — the point is to make a blackhole",
        "terminate, not to enforce a latency budget.",
        "",
        "If the init object is built elsewhere and passed as a variable, inline the",
        "signal at the call site; the scan cannot see into a variable and will not",
        "guess on your behalf.",
      ].join("\n")
    ).toEqual([]);
  });

  it("has no exemption for a call site that is now bounded or gone", () => {
    const live = new Set(sites.filter((s) => !s.bounded).map((s) => `${s.file}:${s.line}`));
    const stale = Object.keys(EXEMPT_CALL_SITES).filter((key) => !live.has(key));

    expect(
      stale,
      [
        "These EXEMPT_CALL_SITES entries no longer describe an unbounded fetch:",
        ...stale.map((key) => `  ${key} — ${EXEMPT_CALL_SITES[key]}`),
        "",
        "Delete them. An exemption that outlives its call site is the same drift",
        "one level up, and line numbers move under it on every edit.",
      ].join("\n")
    ).toEqual([]);
  });
});
