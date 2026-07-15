import type { Agent } from "@/components/agent-list";
import type { TemplateItem } from "@/lib/template-grouping";

/**
 * Build an `Agent` (the `@/components/agent-list` shape) for tests.
 *
 * Inline `{ id, name, model, isPersonal, tagline, avatarSeed }` fixtures drop
 * whichever field was added last (`starterPrompts` was the casualty). The
 * `: Agent` return type keeps this factory honest: add a required field to the
 * interface and this one function fails to compile instead of 20 test files.
 */
export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Test Agent",
    model: "anthropic/claude-haiku-4-5-20251001",
    isPersonal: false,
    tagline: null,
    starterPrompts: [],
    avatarSeed: null,
    ...overrides,
  };
}

/**
 * Build a `TemplateItem` (the `@/lib/template-grouping` shape) for tests.
 *
 * Only the required fields are defaulted (`defaultTagline` was the drift
 * casualty); pass `overrides` for the optional `requires*` / `odooAccessLevel`
 * / `unavailableReason` flags a given test exercises.
 */
export function makeTemplateItem(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    id: "template-1",
    name: "Test Template",
    description: "A test template",
    requiresDirectories: false,
    defaultTagline: null,
    available: true,
    ...overrides,
  };
}
