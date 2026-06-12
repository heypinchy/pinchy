// @vitest-environment node
import { describe, it, expect } from "vitest";
import { evaluateSeatPressure } from "@/lib/seat-grace";

describe("evaluateSeatPressure", () => {
  it("is unlimited when maxUsers is 0 (community / no cap)", () => {
    const p = evaluateSeatPressure(42, 0);
    expect(p.unlimited).toBe(true);
    expect(p.overCap).toBe(false);
    expect(p.inviteAllowed).toBe(true);
    expect(p.graceCap).toBeNull();
  });

  it("computes the grace cap as floor(1.2 * maxUsers)", () => {
    expect(evaluateSeatPressure(0, 10).graceCap).toBe(12);
    expect(evaluateSeatPressure(0, 50).graceCap).toBe(60);
    expect(evaluateSeatPressure(0, 7).graceCap).toBe(8);
  });

  it("is normal up to and including 100%", () => {
    const p = evaluateSeatPressure(10, 10);
    expect(p.overCap).toBe(false);
    expect(p.inviteAllowed).toBe(true);
  });

  it("flags over-cap inside the grace window and still allows invites", () => {
    const at11 = evaluateSeatPressure(11, 10);
    expect(at11.overCap).toBe(true);
    expect(at11.inviteAllowed).toBe(true);

    // Seat 12 is the last grace seat — it exists, but no further invite.
    const at12 = evaluateSeatPressure(12, 10);
    expect(at12.overCap).toBe(true);
    expect(at12.inviteAllowed).toBe(false);
  });

  it("blocks invites beyond the grace cap", () => {
    const p = evaluateSeatPressure(13, 10);
    expect(p.overCap).toBe(true);
    expect(p.inviteAllowed).toBe(false);
  });

  it("never reports over-cap for negative or zero usage", () => {
    const p = evaluateSeatPressure(0, 10);
    expect(p.overCap).toBe(false);
    expect(p.inviteAllowed).toBe(true);
  });
});
