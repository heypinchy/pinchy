import { describe, it, expect } from "vitest";
import { buildBundle } from "@/lib/diagnostics/bundle-builder";

describe("buildBundle", () => {
  const baseInput = {
    spans: [{ name: "agent.turn", attributes: { "gen_ai.request.model": "x" } }],
    versions: { pinchy: "v0.5.4", openclaw: "2026.5.7", openclawNode: "0.9.0" },
    scope: {
      agentId: "agt_1",
      sessionKey: "agent:agt_1:direct:usr_2",
      anchorTurnIndex: 5,
      sessionTurnCount: 12,
      includedTurnRange: [2, 5] as [number, number],
    },
    auditEntries: [],
  };

  it("sets schemaVersion and generatedAt", () => {
    const b = buildBundle(baseInput);
    expect(b.schemaVersion).toBe("pinchy.bugreport.v1");
    expect(b.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes version info verbatim", () => {
    const b = buildBundle(baseInput);
    expect(b.pinchyVersion).toBe("v0.5.4");
    expect(b.openclawVersion).toBe("2026.5.7");
    expect(b.openclawNodeVersion).toBe("0.9.0");
  });

  it("derives skippedTurnsAfterAnchor from scope", () => {
    const b = buildBundle(baseInput);
    expect(b.scope.skippedTurnsAfterAnchor).toBe(7); // 12 - 5
  });

  it("returns skippedTurnsAfterAnchor=0 when anchorTurnIndex is null", () => {
    const b = buildBundle({
      ...baseInput,
      scope: { ...baseInput.scope, anchorTurnIndex: null },
    });
    expect(b.scope.skippedTurnsAfterAnchor).toBe(0);
    expect(b.scope.anchorTurnIndex).toBeNull();
  });

  it("hashes sessionKey to SHA-256, never emits raw key", () => {
    const b = buildBundle(baseInput);
    expect(b.scope.sessionKeyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(b)).not.toContain("agent:agt_1:direct:usr_2");
  });

  it("includes userDescription only when provided", () => {
    expect(buildBundle(baseInput).userDescription).toBeUndefined();
    expect(buildBundle({ ...baseInput, userDescription: "x" }).userDescription).toBe("x");
  });
});
