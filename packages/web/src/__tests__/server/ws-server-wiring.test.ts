import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `server.ts` boots the whole stack and is not unit-testable, so the behaviour
 * lives in `ws-heartbeat.ts` / `ws-reject.ts` and is proved there against real
 * sockets. This file pins the one thing those tests cannot see: that
 * `server.ts` still calls them (#1422). Comments are stripped first, so an
 * explanation of a deleted call does not read as the call.
 */
const source = readFileSync(join(__dirname, "../../../server.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("server.ts /api/ws wiring", () => {
  it("refuses both limiter cases before the handshake completes", () => {
    // A completed handshake fires `open` in the browser, and the chat client
    // resets its backoff on `open` — refused after it, it redials about once a
    // second. Both refusals go through refuseUpgrade, which answers HTTP 429.
    expect(source.match(/refuseUpgrade\(socket\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/4429/);
  });

  it("refuses the rate limit before reading the session", () => {
    const rateLimit = source.indexOf("wsRateLimiter.allowUpgrade(ip)");
    const connectionLimit = source.indexOf("wsRateLimiter.allowConnection(userId)");
    expect(rateLimit).toBeGreaterThan(-1);
    expect(connectionLimit).toBeGreaterThan(rateLimit);
  });

  it("runs the protocol heartbeat on the chat socket server", () => {
    expect(source).toMatch(/startWsHeartbeat\(wss\)/);
  });

  it("answers the client heartbeat before it needs a router", () => {
    const heartbeat = source.indexOf("answerAppHeartbeat(clientWs, parsed)");
    const routerCheck = source.indexOf("if (!router)");
    expect(heartbeat).toBeGreaterThan(-1);
    expect(routerCheck).toBeGreaterThan(-1);
    expect(heartbeat).toBeLessThan(routerCheck);
  });
});
