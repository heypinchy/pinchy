import { describe, it, expect } from "vitest";
import {
  KEEP_ALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  applyKeepAliveTuning,
} from "@/server/http-keepalive";

describe("HTTP keep-alive tuning", () => {
  it("keepAliveTimeout is well above Node's 5s default so an idle socket isn't closed mid-reuse", () => {
    // The flake this guards against: Node's default `keepAliveTimeout` (5s)
    // closes an idle keep-alive socket exactly as a connection-reusing client
    // (browser / Playwright APIRequestContext) sends its next request → the
    // client observes ECONNRESET = "socket hang up". A timeout comfortably
    // longer than any inter-request gap in a test or proxy keep-alive window
    // removes the race.
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("headersTimeout exceeds keepAliveTimeout (else Node kills long-kept-alive connections)", () => {
    // Node requires headersTimeout > keepAliveTimeout: otherwise the
    // headersTimeout can fire while the server is idly waiting for the next
    // request on a kept-alive connection, re-introducing the very reset we're
    // removing. Keeping them in one helper enforces the invariant.
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it("applyKeepAliveTuning sets both timeouts on the server instance", () => {
    const server = {} as { keepAliveTimeout?: number; headersTimeout?: number };
    applyKeepAliveTuning(server as unknown as import("http").Server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
  });
});
