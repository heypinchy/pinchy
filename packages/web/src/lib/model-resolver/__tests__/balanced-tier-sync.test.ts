/**
 * Drift guard: ensure model-resolver balanced-tier resolver outputs stay
 * in sync with BALANCED_ANCHORS (used in the setup wizard UI and
 * seedPersonalAgent). When a BALANCED_ANCHORS value is updated, the
 * corresponding provider resolver must be updated too, and vice versa.
 */
import { describe, expect, it } from "vitest";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";
import { resolveAnthropic } from "@/lib/model-resolver/providers/anthropic";
import { resolveOpenAI } from "@/lib/model-resolver/providers/openai";
import { resolveGoogle } from "@/lib/model-resolver/providers/google";

describe("balanced-tier sync: resolver outputs match BALANCED_ANCHORS", () => {
  it("anthropic balanced resolver output matches BALANCED_ANCHORS[anthropic]", () => {
    const r = resolveAnthropic({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["anthropic"]);
  });

  it("openai balanced resolver output matches BALANCED_ANCHORS[openai]", () => {
    const r = resolveOpenAI({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["openai"]);
  });

  it("google balanced resolver output matches BALANCED_ANCHORS[google]", () => {
    const r = resolveGoogle({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["google"]);
  });
});
