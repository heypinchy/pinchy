import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
}));

import {
  shouldSelfHeal,
  maybeSelfHealOnModelError,
  _resetSelfHealState,
} from "@/server/model-self-heal";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";

const COOLDOWN = 5 * 60 * 1000;

describe("shouldSelfHeal", () => {
  it("triggers on a retired-model error when the cooldown has elapsed", () => {
    const err = new Error('410 "qwen3-vl:235b-instruct was retired"');
    expect(shouldSelfHeal(err, 0, COOLDOWN, COOLDOWN)).toBe(true);
  });

  it("does NOT re-trigger within the cooldown window (burst debounce)", () => {
    const err = new Error("Unknown model: ollama-cloud/foo");
    const lastHeal = 1_000_000;
    // 30s later — a retirement makes every dispatch fail; must not regenerate
    // config on each one.
    expect(shouldSelfHeal(err, lastHeal, lastHeal + 30_000, COOLDOWN)).toBe(false);
  });

  it("does NOT trigger for a non-retirement error even past the cooldown", () => {
    const err = new Error("Local media file not found");
    expect(shouldSelfHeal(err, 0, 10 * COOLDOWN, COOLDOWN)).toBe(false);
  });
});

describe("maybeSelfHealOnModelError", () => {
  beforeEach(() => {
    _resetSelfHealState();
    vi.clearAllMocks();
  });

  it("busts the provider-models cache BEFORE regenerating, so re-resolution fetches a fresh /v1/models", async () => {
    const healed = await maybeSelfHealOnModelError(
      new Error('410 "qwen3-vl:235b-instruct was retired"')
    );
    expect(healed).toBe(true);
    expect(resetCache).toHaveBeenCalledTimes(1);
    expect(regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
    // Order matters: a stale 1h cache would otherwise re-pick the dead model.
    expect(vi.mocked(resetCache).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(regenerateOpenClawConfig).mock.invocationCallOrder[0]
    );
  });

  it("debounces a burst — a second retirement error within the cooldown does not regenerate again", async () => {
    await maybeSelfHealOnModelError(new Error("Unknown model: ollama-cloud/foo"));
    const second = await maybeSelfHealOnModelError(new Error("Unknown model: ollama-cloud/foo"));
    expect(second).toBe(false);
    expect(regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a non-retirement error", async () => {
    const healed = await maybeSelfHealOnModelError(new Error("Local media file not found"));
    expect(healed).toBe(false);
    expect(resetCache).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });
});
