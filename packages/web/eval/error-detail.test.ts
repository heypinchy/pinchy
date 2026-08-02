/**
 * A sweep that dies on the network must say WHICH call died (#869).
 *
 * The first real Layer-3 sweep lost 15 of 48 runs, every one of them recorded
 * as the six words `TypeError: fetch failed`. That is `String(err)` on a node
 * fetch rejection, and it is the least informative form the failure has: node
 * puts the actual fault — `ECONNREFUSED`, `ENOTFOUND`, a TLS error, the
 * address — in `err.cause`, which `String()` discards.
 *
 * The cost is not cosmetic. The KB sweep talks to two very different places
 * inside one try-block: the local stack on `localhost:7781`, and Ollama Cloud
 * for the NLI judge. Those two failures mean opposite things — a dead stack is
 * ours to restart, a dead uplink is the café's wifi — and after the fact the
 * record could not tell them apart. This laptop travels, so an offline stretch
 * is an expected operating condition rather than an incident, and "we could
 * not measure" has to stay distinguishable from "the model failed".
 */

import { describe, expect, it } from "vitest";

import { describeError, isTransportError } from "./error-detail";

/** How node's fetch actually rejects: a bare TypeError carrying the real fault. */
function fetchFailure(cause: unknown): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause?: unknown }).cause = cause;
  return err;
}

function sysError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  return err;
}

describe("describeError", () => {
  it("keeps the plain message of an ordinary error", () => {
    expect(describeError(new Error("boom"))).toBe("Error: boom");
  });

  it("stringifies a non-Error throw without throwing itself", () => {
    expect(describeError("plain string failure")).toBe("plain string failure");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("names the endpoint a fetch failure was really about", () => {
    // The whole point: `String(err)` yields "TypeError: fetch failed" for BOTH
    // of the lines below, and they are the two different incidents the sweep
    // has to be able to tell apart afterwards.
    const localStack = describeError(
      fetchFailure(sysError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:7781"))
    );
    const uplink = describeError(
      fetchFailure(sysError("ENOTFOUND", "getaddrinfo ENOTFOUND ollama.com"))
    );

    expect(localStack).toContain("127.0.0.1:7781");
    expect(localStack).toContain("ECONNREFUSED");
    expect(uplink).toContain("ollama.com");
    expect(uplink).not.toContain("7781");
  });

  it("walks a nested cause chain", () => {
    const inner = sysError("EAI_AGAIN", "getaddrinfo EAI_AGAIN ollama.com");
    const middle = new Error("upstream request failed");
    (middle as Error & { cause?: unknown }).cause = inner;

    const described = describeError(fetchFailure(middle));

    expect(described).toContain("fetch failed");
    expect(described).toContain("upstream request failed");
    expect(described).toContain("EAI_AGAIN");
  });

  it("includes an AggregateError's individual failures", () => {
    // Node raises this when every resolved address fails — happens on a dual
    // stack host the moment the uplink drops, and the per-address codes are
    // the only thing that says whether DNS or the route was the problem.
    const aggregate = new AggregateError(
      [
        sysError("ECONNREFUSED", "connect ECONNREFUSED ::1:7781"),
        sysError("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.5:443"),
      ],
      "all attempts failed"
    );

    const described = describeError(fetchFailure(aggregate));

    expect(described).toContain("ECONNREFUSED");
    expect(described).toContain("EHOSTUNREACH");
  });

  it("terminates on a cause that points back at itself", () => {
    // Never worth debugging at 2am inside a sweep: a self-referential cause
    // must not hang the harness that exists to report the failure.
    const err = new Error("looping");
    (err as Error & { cause?: unknown }).cause = err;

    expect(describeError(err)).toContain("looping");
  });
});

describe("isTransportError", () => {
  it("recognizes a node fetch rejection", () => {
    expect(isTransportError(fetchFailure(sysError("ECONNRESET", "read ECONNRESET")))).toBe(true);
    expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
  ])("recognizes %s anywhere in the cause chain", (code) => {
    expect(isTransportError(fetchFailure(sysError(code, `failed with ${code}`)))).toBe(true);
  });

  it("recognizes a socket hang up, which carries no code", () => {
    expect(isTransportError(new Error("socket hang up"))).toBe(true);
  });

  // Three of the four calls in the retried dispatch block go through
  // Playwright, not node fetch: loginViaUI and dispatchAndScrape navigate
  // (`page.goto`), and getRawAssistantMessage reads the diagnostics export
  // through `page.request`. Playwright puts EVERYTHING in the message —
  // measured against @playwright/test, the thrown error's own keys are
  // ["log", "name"], `code` is undefined and there is no `cause` at all. A
  // check that reads only `err.code` therefore calls the local stack going
  // away "the measurement" and never retries it.
  it.each([
    "apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:7781",
    "apiRequestContext.post: getaddrinfo ENOTFOUND ollama.com",
    "apiRequestContext.get: connect ETIMEDOUT 10.0.0.5:443",
    "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:7781/chat/a/b",
    "page.goto: net::ERR_NAME_NOT_RESOLVED at http://localhost:7781/",
    "page.goto: net::ERR_INTERNET_DISCONNECTED at http://localhost:7781/",
  ])("recognizes a code-less Playwright transport fault: %s", (message) => {
    expect(isTransportError(new Error(message))).toBe(true);
  });

  it.each([
    // How this repo's X-Frame-Options defect presents (AGENTS.md) — a product
    // bug, and retrying it four times is exactly how one disappears behind a
    // note blaming the uplink.
    "page.goto: net::ERR_BLOCKED_BY_RESPONSE at http://localhost:7781/api/files/x.pdf",
    // A navigation the page itself cancelled, not a connection that failed.
    "page.goto: net::ERR_ABORTED at http://localhost:7781/chat/a/b",
    // Configuration, not weather: a retry cannot fix a certificate.
    "page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://localhost:7781/",
  ])("does NOT treat %s as a transport fault", (message) => {
    expect(isTransportError(new Error(message))).toBe(false);
  });

  it("does NOT claim an assertion failure is a network problem", () => {
    // The dividing line this whole module exists to draw. Retrying a real
    // defect four times turns one wrong answer into four, and hides it behind
    // a note that says the network was at fault.
    expect(isTransportError(new Error("expected 3 to equal 4"))).toBe(false);
  });

  it("does NOT treat a run timeout as a transport fault", () => {
    // A model that never stops talking is model behaviour and belongs in the
    // scorecard as such. Only the harness's OWN plumbing is retryable here.
    expect(isTransportError(new Error("Timeout 120000ms exceeded waiting for idle"))).toBe(false);
    expect(isTransportError(new Error("locator.click: Timeout 30000ms exceeded"))).toBe(false);
  });

  it("does not blow up on a non-Error throw", () => {
    expect(isTransportError("fetch failed")).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });
});
