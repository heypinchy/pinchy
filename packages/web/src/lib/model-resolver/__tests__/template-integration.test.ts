import { describe, expect, it, vi } from "vitest";
import { resolveModelForTemplate } from "..";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "@/lib/ollama-cloud-models";
import type { ProviderName } from "@/lib/providers";

vi.mock("@/lib/provider-models", () => ({
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

// Representative templates across all three tiers.
const CASES: Array<{ templateId: string; provider: ProviderName; expected: string }> = [
  // Reasoning tier
  {
    templateId: "odoo-sales-analyst",
    provider: "anthropic",
    expected: "anthropic/claude-opus-4-7",
  },
  { templateId: "odoo-sales-analyst", provider: "openai", expected: "openai/gpt-5.5" },
  {
    templateId: "odoo-sales-analyst",
    provider: "google",
    expected: "google/gemini-2.5-pro",
  },

  // Fast tier
  {
    templateId: "odoo-inventory-scout",
    provider: "anthropic",
    expected: "anthropic/claude-haiku-4-5-20251001",
  },
  { templateId: "odoo-inventory-scout", provider: "openai", expected: "openai/gpt-5.4-mini" },
  {
    templateId: "odoo-inventory-scout",
    provider: "google",
    expected: "google/gemini-2.5-flash-lite",
  },

  // Balanced tier
  {
    templateId: "odoo-crm-assistant",
    provider: "anthropic",
    expected: "anthropic/claude-sonnet-4-6",
  },
  { templateId: "knowledge-base", provider: "anthropic", expected: "anthropic/claude-sonnet-4-6" },

  // Balanced + vision/long-context/tools — all Anthropic tiers satisfy these capabilities
  {
    templateId: "contract-analyzer",
    provider: "anthropic",
    expected: "anthropic/claude-sonnet-4-6",
  },
  { templateId: "contract-analyzer", provider: "openai", expected: "openai/gpt-5.4" },
  { templateId: "contract-analyzer", provider: "google", expected: "google/gemini-2.5-flash" },
];

describe("template + provider resolves to expected model", () => {
  it.each(CASES)(
    "$templateId + $provider → $expected",
    async ({ templateId, provider, expected }) => {
      const template = AGENT_TEMPLATES[templateId];
      expect(template, `template ${templateId} not found`).toBeDefined();
      expect(template.modelHint, `template ${templateId} has no modelHint`).toBeDefined();

      const result = await resolveModelForTemplate({
        hint: template.modelHint!,
        provider,
      });

      expect(result.model).toBe(expected);
    }
  );
});

/**
 * Regression guard for the v0.5.0 staging bug where the CRM template's
 * `tier=balanced + general` hint resolved to `ollama-cloud/llama3.3:70b`,
 * a model that no longer exists on Ollama Cloud — surfacing as
 * `HTTP 404: model "llama3.3:70b" not found` to the user.
 *
 * Walks every template that has a `modelHint`, resolves it under the
 * Ollama Cloud provider, and asserts the resulting model ID is in the
 * curated `TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS` list — the only IDs we
 * know Ollama Cloud actually serves.
 *
 * The static type-level guard (OllamaCloudModelId in the resolver) catches
 * this at compile time for a single resolver. This test catches it at
 * runtime across every template-resolver pairing — a second line of
 * defence that survives any future code path that bypasses the type.
 */
describe("every template resolves to an actually-existing Ollama Cloud model", () => {
  const templatesWithHint = Object.entries(AGENT_TEMPLATES)
    .filter(([, t]) => t.modelHint !== undefined)
    .map(([id, t]) => ({ id, hint: t.modelHint! }));

  it.each(templatesWithHint)("$id resolves to a curated Ollama Cloud model", async ({ hint }) => {
    const result = await resolveModelForTemplate({ hint, provider: "ollama-cloud" });
    const idWithoutPrefix = result.model.replace(/^ollama-cloud\//, "");
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).toContain(idWithoutPrefix);
  });
});
