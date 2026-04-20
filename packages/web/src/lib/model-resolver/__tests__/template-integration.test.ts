import { describe, expect, it, vi } from "vitest";
import { resolveModelForTemplate } from "..";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
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
    expected: "anthropic/claude-opus-4-6",
  },
  { templateId: "odoo-sales-analyst", provider: "openai", expected: "openai/o3" },
  {
    templateId: "odoo-sales-analyst",
    provider: "google",
    expected: "google/gemini-2.5-pro-preview",
  },

  // Fast tier
  {
    templateId: "odoo-inventory-scout",
    provider: "anthropic",
    expected: "anthropic/claude-haiku-4-5-20251001",
  },
  { templateId: "odoo-inventory-scout", provider: "openai", expected: "openai/gpt-4o-mini" },
  { templateId: "odoo-inventory-scout", provider: "google", expected: "google/gemini-2.5-flash" },

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
  { templateId: "contract-analyzer", provider: "openai", expected: "openai/gpt-4o" },
  { templateId: "contract-analyzer", provider: "google", expected: "google/gemini-2.5-pro" },
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
