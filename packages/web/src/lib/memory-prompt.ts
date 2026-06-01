/**
 * Builds the `## Memory` capability block injected into an agent's
 * `extraSystemPrompt`.
 *
 * Why this lives in the system prompt and NOT in AGENTS.md / SOUL.md:
 * persisting memory is a PLATFORM capability every write-capable agent has,
 * not agent-specific behavior a user authored. AGENTS.md is user-editable;
 * baking a core capability there would let a user silently delete it and
 * would drift per-agent. extraSystemPrompt is rebuilt by OpenClaw every turn,
 * so the hint is always present and always current.
 *
 * Gated on `pinchy_write`: an agent with no write path literally cannot
 * persist memory (group:fs is denied; pinchy_write is the only writer — see
 * build.ts). Telling such an agent it has memory would reproduce the
 * hallucination this whole change fixes (#368), just from the other side.
 */
export function buildMemoryPromptBlock(allowedTools: string[]): string | null {
  if (!allowedTools.includes("pinchy_write")) return null;

  return [
    "## Memory",
    "You have persistent memory that survives across conversations:",
    "- **Long-term** — `MEMORY.md` holds curated, durable knowledge worth keeping.",
    "- **Daily notes** — append raw observations to `memory/YYYY-MM-DD.md`.",
    "",
    "Write to these with your `pinchy_write` tool. Your memory is indexed " +
      "automatically — recall it later with `memory_search` and `memory_get`. " +
      "When the user asks you to remember something, actually write it; don't " +
      "just say you will.",
    "",
    "Your identity and instructions (`SOUL.md`, `AGENTS.md`) are " +
      "platform-managed and not writable — don't try to change who you are by " +
      "editing them; use your memory instead.",
  ].join("\n");
}
