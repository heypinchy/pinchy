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
 * Gated on `pinchy_memory`: an agent without that grant has no memory paths at
 * all (build.ts emits them from this grant alone), so it literally cannot
 * persist memory — group:fs is denied and pinchy-files is the only writer.
 * Telling such an agent it has memory would reproduce the hallucination this
 * whole change fixes (#368), just from the other side.
 *
 * The gate used to be `pinchy_write`, which is what made an agent's memory a
 * side effect of a checkbox about files: no template granted pinchy_write, so
 * every template-created agent silently had no memory (#755).
 *
 * Recall fallback: `memory_search` / `memory_get` ride on OpenClaw's memory-core
 * embedding index, which is unavailable whenever no embedding provider is
 * configured (production: the default `openai` provider has no key → 0 indexed
 * chunks → the tool returns `disabled`). When that happened the agent used to
 * confabulate ("the memory index changed, tell me again"). So we steer it to the
 * ALWAYS-working path: reading its own memory files with `pinchy_read`, using
 * `pinchy_ls` to discover topic notes. This is safe to promise unconditionally
 * here because a memory-granted agent ALWAYS has those tools with its
 * `MEMORY.md` + `memory/` dir in `allowed_paths` — `computeAllowedTools()`
 * emits pinchy_read / pinchy_ls for every agent, and build.ts grants the memory
 * paths from exactly the grant this block is gated on (the per-agent
 * `allowedTools` DB column is Pinchy's UI grant model, NOT the emitted OpenClaw
 * allowlist, so it must not gate the tool names themselves).
 *
 * `pinchy_write` is still the tool named in the text below, and still correct:
 * pinchy-files registers it off the presence of write_paths, so a memory-only
 * agent has it, scoped to its memory and nothing else.
 */
export function buildMemoryPromptBlock(allowedTools: string[]): string | null {
  if (!allowedTools.includes("pinchy_memory")) return null;

  return [
    "## Memory",
    "You have persistent memory that survives across conversations:",
    "- **Long-term** — `MEMORY.md` holds curated, durable knowledge worth " +
      "keeping. Keep it as an index that points to your topic notes.",
    "- **Daily notes** — append raw observations to `memory/YYYY-MM-DD.md`.",
    "",
    "Write to these with your `pinchy_write` tool. When the user asks you to " +
      "remember something, actually write it; don't just say you will.",
    "",
    "To recall what you stored, read your memory files with `pinchy_read` — " +
      "`MEMORY.md` and the notes under `memory/`. Use `pinchy_ls` on `memory/` " +
      "to find topic notes when you don't know the filename. Your memory is also " +
      "indexed for faster `memory_search` / `memory_get`, but that index may be " +
      "unavailable; if a search returns nothing or reports it is unavailable, " +
      "fall back to reading the files. If you still can't find it, say you " +
      'checked — never invent a reason like "the index changed" and never ask ' +
      "the user to repeat something you already saved.",
    "",
    "Your identity and instructions (`SOUL.md`, `AGENTS.md`) are " +
      "platform-managed and not writable — don't try to change who you are by " +
      "editing them; use your memory instead.",
  ].join("\n");
}
