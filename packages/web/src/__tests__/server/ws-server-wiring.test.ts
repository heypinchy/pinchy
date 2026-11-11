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
  it("never answers a WebSocket upgrade with a raw HTTP 429", () => {
    // The browser sees a refused upgrade as 1006 and cannot tell it from an
    // outage; a limiter refusal must go through rejectUpgrade instead.
    expect(source).not.toMatch(/HTTP\/1\.1 429/);
  });

  it("refuses both limiter cases with a readable close code", () => {
    expect(source).toMatch(/rejectUpgrade\([^)]*"rate_limited"\)/);
    expect(source).toMatch(/rejectUpgrade\([^)]*"too_many_connections"\)/);
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
