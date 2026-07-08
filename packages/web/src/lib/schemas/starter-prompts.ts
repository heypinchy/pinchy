import { z } from "zod";

/**
 * A single starter prompt must fit on a chip — one or two short lines. Shared
 * by the settings editor (`maxLength`), the PATCH schema, and the per-template
 * drift guard so all three agree on one number.
 */
export const MAX_STARTER_PROMPT_LENGTH = 100;

/**
 * Upper bound on how many chips one agent can show. Custom GPTs cap conversation
 * starters at 4 and Copilot Studio at 10; 10 keeps us generous while stopping a
 * buggy or hostile client from pushing an unbounded list into the empty chat.
 */
export const MAX_STARTER_PROMPTS = 10;

/** Trim, drop blank entries, and de-duplicate while preserving first-seen order. */
export function normalizeStarterPrompts(prompts: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const prompt of prompts) {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Editable per-agent starter prompts. Bounds the raw client input (length and
 * count), then normalizes to the shape the chat renders: trimmed, non-blank,
 * and unique so `key={prompt}` chips never collide.
 */
export const starterPromptsSchema = z
  .array(z.string().max(MAX_STARTER_PROMPT_LENGTH))
  .max(MAX_STARTER_PROMPTS)
  .transform(normalizeStarterPrompts);
