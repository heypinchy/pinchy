import { describe, it, expect, beforeEach } from "vitest";
import {
  recordConfigRegenSuccess,
  recordConfigRegenFailure,
  getConfigRegenState,
} from "@/lib/openclaw-config-health";

describe("openclaw-config-health", () => {
  beforeEach(() => {
    // The state lives on globalThis (shared across module scopes); clear it so
    // each test starts from the never-recorded default.
    delete (globalThis as Record<string, unknown>)["__pinchyOpenClawConfigRegenState"];
  });

  it("defaults to ok when nothing has been recorded (fresh boot / setup incomplete)", () => {
    // A never-yet-regenerated instance must not be flagged as broken — #879 is
    // about surfacing *failures*, not treating "hasn't run" as failure.
    expect(getConfigRegenState()).toEqual({ ok: true });
  });

  it("records a failure with its actionable message", () => {
    recordConfigRegenFailure("docker-compose.yml is missing the openclaw-secrets volume");
    const state = getConfigRegenState();
    expect(state.ok).toBe(false);
    expect(state.error).toMatch(/openclaw-secrets volume/);
    expect(state.at).toEqual(expect.any(String));
  });

  it("records a success and clears any prior error (self-heal on later good regen)", () => {
    recordConfigRegenFailure("something broke");
    recordConfigRegenSuccess();
    const state = getConfigRegenState();
    expect(state.ok).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.at).toEqual(expect.any(String));
  });
});
