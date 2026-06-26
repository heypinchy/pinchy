import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createUpgradeRouter } from "@/server/upgrade-router";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

function makeRequest(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

function makeSocket() {
  return { destroy: vi.fn(), end: vi.fn(), write: vi.fn() } as unknown as Duplex;
}

const head = Buffer.alloc(0);

describe("createUpgradeRouter", () => {
  it("routes /api/ws upgrades to the Pinchy WebSocket handler", () => {
    const handlePinchyWs = vi.fn();
    const route = createUpgradeRouter({ handlePinchyWs });

    route(makeRequest("/api/ws"), makeSocket(), head);

    expect(handlePinchyWs).toHaveBeenCalledTimes(1);
  });

  it("routes /api/ws with query string to the Pinchy handler", () => {
    const handlePinchyWs = vi.fn();
    const route = createUpgradeRouter({ handlePinchyWs });

    route(makeRequest("/api/ws?foo=bar"), makeSocket(), head);

    expect(handlePinchyWs).toHaveBeenCalledTimes(1);
  });

  // Regression guard for the dev-mode hydration hang: Next.js answers HMR
  // upgrades through its OWN listener (registered because server.ts passes
  // `httpServer` to next()). Pinchy's router must neither consume nor
  // destroy these sockets — touching them kills dev HMR, and Next 16's dev
  // hydration waits on the HMR channel forever, freezing every page at its
  // server-rendered shell (the setup wizard's eternal
  // "Checking infrastructure..." spinner).
  it.each(["/_next/webpack-hmr", "/_next/webpack-hmr?id=abc123"])(
    "leaves %s untouched for Next.js's own upgrade listener",
    (path) => {
      const handlePinchyWs = vi.fn();
      const route = createUpgradeRouter({ handlePinchyWs });
      const socket = makeSocket();

      route(makeRequest(path), socket, head);

      expect(handlePinchyWs).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(socket.end).not.toHaveBeenCalled();
      expect(socket.write).not.toHaveBeenCalled();
    }
  );

  it("leaves unknown upgrade paths untouched (Next decides, not Pinchy)", () => {
    const handlePinchyWs = vi.fn();
    const route = createUpgradeRouter({ handlePinchyWs });
    const socket = makeSocket();

    route(makeRequest("/some/unknown/ws"), socket, head);

    expect(handlePinchyWs).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.end).not.toHaveBeenCalled();
  });
});

describe("server.ts / next.config.ts dev-HMR wiring (drift guards)", () => {
  // The router above only keeps /api/ws working. Dev HMR additionally
  // requires two pieces of wiring that nothing else exercises in CI
  // (production builds have no HMR, so E2E suites stay green even when dev
  // is completely broken). Pin them at the source level — same pattern as
  // auth-config-consistency.test.ts.
  const serverSource = readFileSync(resolve(__dirname, "../../../server.ts"), "utf-8");
  const nextConfigSource = readFileSync(resolve(__dirname, "../../../next.config.ts"), "utf-8");

  it("passes the http server to next() so Next registers its HMR upgrade listener", () => {
    expect(serverSource).toMatch(/next\(\{[^}]*httpServer:\s*server/s);
  });

  it("uses the shared upgrade router for Pinchy's /api/ws handling", () => {
    expect(serverSource).toContain("createUpgradeRouter");
  });

  it("allows 127.0.0.1 as a dev origin so HMR works without the Caddy domain", () => {
    // Next's implicit allowance covers localhost but NOT 127.0.0.1 — without
    // this entry, pages opened via http://127.0.0.1:7777 never hydrate in dev
    // ("Blocked cross-origin request to /_next/webpack-hmr").
    expect(nextConfigSource).toMatch(/allowedDevOrigins:\s*\[[^\]]*"127\.0\.0\.1"/s);
  });
});
