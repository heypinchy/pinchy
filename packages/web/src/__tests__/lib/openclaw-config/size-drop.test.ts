// Pure helpers behind the two size-drop paths: Pinchy's own #311 guard in
// build.ts and the stepwise delivery of a deliberate shrink in write.ts.
// The end-to-end behaviour is covered by openclaw-config.test.ts (guard),
// push-size-drop.test.ts (push against a fake OpenClaw) and
// integration/openclaw-config-size-drop-against-oc.test.ts (real OpenClaw).
import { describe, it, expect } from "vitest";
import {
  sizeGuardBaseline,
  parseSizeDropRejection,
  buildProviderShrinkStep,
  planShrinkPush,
  utf8Bytes,
} from "@/lib/openclaw-config/size-drop";

type Json = Record<string, unknown>;

function model(i: number) {
  return {
    id: `acme-model-${i}-with-a-realistically-long-identifier`,
    name: `Acme Model ${i}`,
    contextWindow: 128000,
    maxTokens: 8192,
    input: ["text"],
  };
}

function provider(models: number, extra: Json = {}): Json {
  return {
    baseUrl: "https://acme.example/v1",
    api: "openai-completions",
    apiKey: { source: "file", provider: "pinchy", id: "/providers/acme/apiKey" },
    models: Array.from({ length: models }, (_, i) => model(i)),
    ...extra,
  };
}

const anthropic = { baseUrl: "https://api.anthropic.com", models: [{ id: "claude", name: "C" }] };

function config(providers: Json, extra: Json = {}): Json {
  return {
    gateway: { mode: "local", auth: { mode: "token", token: "t".repeat(40) } },
    agents: { list: [{ id: "smithers", name: "Smithers" }] },
    models: { providers },
    ...extra,
  };
}

const serialize = (c: Json) => JSON.stringify(c, null, 2).trimEnd() + "\n";

describe("sizeGuardBaseline", () => {
  it("discounts the bytes a deleted provider took when another provider survives", () => {
    const existing = serialize(config({ anthropic, acme: provider(40) }));
    const next = config({ anthropic });
    const baseline = sizeGuardBaseline(existing, next);
    expect(baseline).toBe(serialize(config({ anthropic })).length);
    expect(baseline).toBeLessThan(existing.length * 0.5);
  });

  it("discounts a provider whose model list shrank (live discovery returned fewer models)", () => {
    const existing = serialize(config({ anthropic, acme: provider(40) }));
    const next = config({ anthropic, acme: provider(2) });
    expect(sizeGuardBaseline(existing, next)).toBe(serialize(next).length);
  });

  it("does not discount anything when the new payload has no provider at all (#311 empty read)", () => {
    const existing = serialize(config({ anthropic, acme: provider(40) }));
    expect(sizeGuardBaseline(existing, config({}))).toBe(existing.length);
    const noModels = config({});
    delete noModels.models;
    expect(sizeGuardBaseline(existing, noModels)).toBe(existing.length);
  });

  it("discounts ONLY the provider catalog — a shrink elsewhere is measured in full", () => {
    const padding = "x".repeat(8000);
    const existing = serialize(config({ anthropic, acme: provider(40) }, { secrets: { padding } }));
    const next = config({ anthropic });
    // The baseline still carries the 8000 bytes of non-provider state the new
    // payload lost, so the guard keeps judging that part.
    expect(sizeGuardBaseline(existing, next)).toBeGreaterThan(8000);
  });

  it("never raises the baseline above the existing file (a provider that grew is no discount)", () => {
    const existing = serialize(config({ anthropic }));
    const next = config({ anthropic, acme: provider(40) });
    expect(sizeGuardBaseline(existing, next)).toBe(existing.length);
  });

  it("falls back to the raw length for an unparseable existing file", () => {
    expect(sizeGuardBaseline("{not json", config({ anthropic }))).toBe("{not json".length);
  });
});

describe("parseSizeDropRejection", () => {
  it("reads OpenClaw's config.apply size-drop rejection", () => {
    expect(
      parseSizeDropRejection(
        "Config write rejected: /root/.openclaw/openclaw.json (size-drop:22414->2103). Rejected payload saved to /root/.openclaw/openclaw.json.rejected.2026-11-02T14-12-06-386Z."
      )
    ).toEqual({ fromBytes: 22414, toBytes: 2103 });
  });

  it("ignores the observe-side last-good anomaly and unrelated errors", () => {
    expect(parseSizeDropRejection("Config observe anomaly: x (size-drop-vs-last-good:1->2)")).toBe(
      null
    );
    expect(parseSizeDropRejection("rate limit exceeded; retry after 30s")).toBe(null);
  });
});

describe("buildProviderShrinkStep", () => {
  const ocConfig = config({ anthropic, acme: provider(40) });
  const target = config({ anthropic });

  it("re-adds just enough of the deleted provider's models to reach the minimum", () => {
    const minBytes = Math.ceil(utf8Bytes(serialize(ocConfig)) / 2);
    const step = buildProviderShrinkStep(target, ocConfig, minBytes)!;
    expect(step).not.toBeNull();
    const bytes = utf8Bytes(serialize(step));
    expect(bytes).toBeGreaterThanOrEqual(minBytes);
    const stepModels = (step.models as { providers: { acme: { models: unknown[] } } }).providers
      .acme.models;
    expect(stepModels.length).toBeGreaterThan(0);
    expect(stepModels.length).toBeLessThan(40);
    // Minimal: one model fewer would miss the minimum.
    const oneFewer = structuredClone(step);
    (oneFewer.models as { providers: { acme: { models: unknown[] } } }).providers.acme.models.pop();
    expect(utf8Bytes(serialize(oneFewer))).toBeLessThan(minBytes);
  });

  it("never carries the deleted provider's SecretRef — secrets.json no longer resolves it", () => {
    const step = buildProviderShrinkStep(target, ocConfig, utf8Bytes(serialize(ocConfig)) / 2)!;
    expect((step.models as { providers: { acme: Json } }).providers.acme).not.toHaveProperty(
      "apiKey"
    );
    expect((step.models as { providers: { acme: Json } }).providers.acme.baseUrl).toBe(
      "https://acme.example/v1"
    );
  });

  it("leaves everything outside models.providers exactly as the target has it", () => {
    const step = buildProviderShrinkStep(target, ocConfig, utf8Bytes(serialize(ocConfig)) / 2)!;
    const withoutModels = (c: Json) =>
      Object.fromEntries(Object.entries(c).filter(([k]) => k !== "models"));
    expect(withoutModels(step)).toEqual(withoutModels(target));
    expect((step.models as { providers: Json }).providers.anthropic).toEqual(anthropic);
  });

  it("does not mutate its inputs", () => {
    const before = [structuredClone(target), structuredClone(ocConfig)];
    buildProviderShrinkStep(target, ocConfig, utf8Bytes(serialize(ocConfig)) / 2);
    expect([target, ocConfig]).toEqual(before);
  });

  it("returns null when even all provider content cannot reach the minimum (shrink is elsewhere)", () => {
    const bloatedOc = config(
      { anthropic, acme: provider(2) },
      { secrets: { pad: "x".repeat(9000) } }
    );
    expect(
      buildProviderShrinkStep(config({ anthropic }), bloatedOc, utf8Bytes(serialize(bloatedOc)) / 2)
    ).toBeNull();
  });
});

describe("planShrinkPush", () => {
  // A realistically sized remainder (> 1 kB), so "clears the 50% rule" is not
  // swallowed by the safety margin.
  const agents = {
    list: Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}` })),
  };
  const target = serialize(config({ anthropic }, { agents }));
  const ocConfig = config({ anthropic, acme: provider(40) });
  const ocBaselineBytes = utf8Bytes(serialize(ocConfig));

  it("sends a step while the target would still trip OpenClaw's 50% rule", () => {
    const plan = planShrinkPush({ target, ocConfig, ocBaselineBytes, offset: 0 })!;
    expect(plan.isStep).toBe(true);
    expect(utf8Bytes(plan.payload)).toBeGreaterThanOrEqual(Math.floor(ocBaselineBytes * 0.5));
  });

  it("sends the target once it clears the 50% rule against OpenClaw's baseline", () => {
    expect(utf8Bytes(target)).toBeGreaterThan(1024);
    const plan = planShrinkPush({
      target,
      ocConfig,
      ocBaselineBytes: utf8Bytes(target) + 100,
      offset: 0,
    })!;
    expect(plan).toEqual({ payload: target, isStep: false });
  });

  it("honours the calibration offset between Pinchy's bytes and OpenClaw's", () => {
    // OpenClaw's output for our payload is 400 bytes larger than ours (meta
    // stamps): a target that is just under half in Pinchy's count clears it in
    // OpenClaw's.
    const baseline = 2 * utf8Bytes(target) + 200;
    expect(planShrinkPush({ target, ocConfig, ocBaselineBytes: baseline, offset: 0 })!.isStep).toBe(
      true
    );
    expect(
      planShrinkPush({ target, ocConfig, ocBaselineBytes: baseline, offset: 400 })!.isStep
    ).toBe(false);
  });

  it("returns null when no step can explain the shrink", () => {
    expect(
      planShrinkPush({
        target,
        ocConfig: config({ anthropic }),
        ocBaselineBytes: 50_000,
        offset: 0,
      })
    ).toBeNull();
    expect(
      planShrinkPush({ target, ocConfig: undefined, ocBaselineBytes: 50_000, offset: 0 })
    ).toBe(null);
  });
});
