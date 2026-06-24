import { describe, it, expect } from "vitest";
import { shouldSelfHeal } from "@/server/model-self-heal";

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
