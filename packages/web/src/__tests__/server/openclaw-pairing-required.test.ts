import { describe, it, expect } from "vitest";

// Smoke test: verify the version of openclaw-node we depend on exposes the
// 0.8.0 pairingRequired event surface. Protects against an accidental
// downgrade in pnpm-lock.yaml.
describe("openclaw-node 0.8.0+ pairingRequired surface", () => {
  it("parsePairingRequiredReason is exported from openclaw-node", async () => {
    const mod = await import("openclaw-node");
    expect(typeof (mod as unknown as Record<string, unknown>)["parsePairingRequiredReason"]).toBe(
      "function"
    );
  });

  it("parsePairingRequiredReason correctly parses a full pairing-required close reason", async () => {
    const { parsePairingRequiredReason } = (await import("openclaw-node")) as unknown as {
      parsePairingRequiredReason: (
        raw: string
      ) => { requestId?: string; reason?: string; raw: string } | null;
    };
    const result = parsePairingRequiredReason(
      "pairing required: scope-upgrade (requestId: req-abc)"
    );
    expect(result).toEqual({
      requestId: "req-abc",
      reason: "scope-upgrade",
      raw: "pairing required: scope-upgrade (requestId: req-abc)",
    });
  });
});
