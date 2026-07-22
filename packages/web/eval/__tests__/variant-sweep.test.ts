import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptVariantId, RunResult } from "../../src/lib/eval/types";
import {
  countRunsForVariant,
  promptVariantsFromEnv,
  runOnce,
  variantRunsPerModelFromEnv,
} from "../run-eval";

/**
 * Variant-aware sweep orchestration (#803, PR 3): the model sweep dispatches
 * the primary prompt at EVAL_N and, when opted in via EVAL_PROMPT_VARIANTS,
 * each paraphrase variant at EVAL_VARIANT_RUNS (default 6). These tests cover
 * the pure orchestration pieces the sweep spec composes: env parsing, the
 * per-(model, variant) resume counting, and the runOnce both-params guard.
 */

describe("promptVariantsFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to no variants (primary-only sweep) when the env var is unset", () => {
    vi.stubEnv("EVAL_PROMPT_VARIANTS", "");
    expect(promptVariantsFromEnv()).toEqual([]);
  });

  it("parses a comma-separated variant list, tolerating whitespace", () => {
    vi.stubEnv("EVAL_PROMPT_VARIANTS", " v1 , v2 ");
    expect(promptVariantsFromEnv()).toEqual(["v1", "v2"]);
  });

  it("accepts a single variant", () => {
    vi.stubEnv("EVAL_PROMPT_VARIANTS", "v2");
    expect(promptVariantsFromEnv()).toEqual(["v2"]);
  });

  it("throws on an unknown variant id instead of dispatching a mislabeled sweep", () => {
    // A typo must fail BEFORE the sweep starts, not hours in when
    // resolvePromptForVariant first sees the bad id.
    vi.stubEnv("EVAL_PROMPT_VARIANTS", "v1,v3");
    expect(() => promptVariantsFromEnv()).toThrow(/v3/);
  });

  it('throws on "primary" — the primary always runs and is configured via EVAL_N', () => {
    // Allowing it would double-dispatch the primary at the variant run count.
    vi.stubEnv("EVAL_PROMPT_VARIANTS", "primary,v1");
    expect(() => promptVariantsFromEnv()).toThrow(/primary/);
  });

  it("throws on a duplicated variant id", () => {
    vi.stubEnv("EVAL_PROMPT_VARIANTS", "v1,v1");
    expect(() => promptVariantsFromEnv()).toThrow(/v1/);
  });
});

describe("variantRunsPerModelFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the default when EVAL_VARIANT_RUNS is unset", () => {
    vi.stubEnv("EVAL_VARIANT_RUNS", "");
    expect(variantRunsPerModelFromEnv(6)).toBe(6);
  });

  it("parses a positive integer override", () => {
    vi.stubEnv("EVAL_VARIANT_RUNS", "4");
    expect(variantRunsPerModelFromEnv(6)).toBe(4);
  });

  it("falls back to the default on zero, negative, or non-numeric values", () => {
    for (const bad of ["0", "-2", "abc"]) {
      vi.stubEnv("EVAL_VARIANT_RUNS", bad);
      expect(variantRunsPerModelFromEnv(6)).toBe(6);
    }
  });

  it("floors a fractional value", () => {
    vi.stubEnv("EVAL_VARIANT_RUNS", "3.9");
    expect(variantRunsPerModelFromEnv(6)).toBe(3);
  });
});

describe("countRunsForVariant", () => {
  const row = (model: string, promptVariant?: PromptVariantId): RunResult => ({
    model,
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 1,
    ...(promptVariant !== undefined ? { promptVariant } : {}),
  });

  it("keys on (model, promptVariant), not model alone", () => {
    // The pre-variant counter counted per model only — 6 v1 rows would have
    // been mistaken for primary coverage and needed primary runs skipped.
    const runs = [row("m-a", "primary"), row("m-a", "v1"), row("m-a", "v1"), row("m-b", "v1")];
    expect(countRunsForVariant(runs, "m-a", "primary")).toBe(1);
    expect(countRunsForVariant(runs, "m-a", "v1")).toBe(2);
    expect(countRunsForVariant(runs, "m-a", "v2")).toBe(0);
    expect(countRunsForVariant(runs, "m-b", "v1")).toBe(1);
  });

  it('treats rows WITHOUT the field as "primary" (grandfathered pre-#803 rows)', () => {
    const runs = [row("m-a"), row("m-a"), row("m-a", "primary"), row("m-a", "v2")];
    expect(countRunsForVariant(runs, "m-a", "primary")).toBe(3);
    expect(countRunsForVariant(runs, "m-a", "v2")).toBe(1);
  });

  it("returns 0 on an empty run list", () => {
    expect(countRunsForVariant([], "m-a", "primary")).toBe(0);
  });
});

describe("runOnce both-params guard", () => {
  // A page whose first interaction throws a sentinel: reaching it proves the
  // guard let the call through to dispatch (we never want a real dispatch in
  // a unit test).
  const SENTINEL = "SENTINEL_DISPATCH_REACHED";
  const sentinelPage = {
    goto: () => {
      throw new Error(SENTINEL);
    },
  } as unknown as Page;

  const base = { page: sentinelPage, cookie: "c", agentId: "a", model: "m" };

  it("throws when BOTH a prompt override and a non-default promptVariant are passed", async () => {
    // A custom prompt labeled with a variant would dispatch the override text
    // while every persisted row claims the variant's wording — poisoning the
    // variant comparison. Must fail loudly before dispatching anything.
    await expect(runOnce({ ...base, prompt: "custom text", promptVariant: "v1" })).rejects.toThrow(
      /prompt/
    );
  });

  it("allows a prompt override WITHOUT promptVariant (the selftest idiom)", async () => {
    // Reaching the sentinel proves the guard did not fire.
    await expect(runOnce({ ...base, prompt: "custom text" })).rejects.toThrow(SENTINEL);
  });

  it('allows a prompt override with an explicit default promptVariant "primary"', async () => {
    await expect(
      runOnce({ ...base, prompt: "custom text", promptVariant: "primary" })
    ).rejects.toThrow(SENTINEL);
  });

  it("allows a non-default promptVariant WITHOUT a prompt override", async () => {
    await expect(runOnce({ ...base, promptVariant: "v1" })).rejects.toThrow(SENTINEL);
  });
});
