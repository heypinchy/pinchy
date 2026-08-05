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
 *
 * Why the text says WHERE to write, not just how. Two shapes of the same failure
 * were reported in production, and both were caused by this block rather than by
 * the runtime:
 *
 *   1. It used to say "keep [MEMORY.md] as an index that points to your topic
 *      notes". `MEMORY.md` is the ONLY memory file OpenClaw injects at session
 *      start (`loadWorkspaceBootstrapFiles`; the notes under `memory/` are
 *      indexed for search, never injected), so that instruction put every
 *      durable fact one tool call behind the answer. An agent then opened a
 *      fresh session knowing the NAME of the note it needed and answered without
 *      reading it. Hence: content in `MEMORY.md`, pointers only for the tail,
 *      and an explicit "before you answer" rather than a passive "you can read".
 *
 *   2. A working rule the user and agent developed together — a scoring
 *      framework, a standard procedure — landed in memory because that is the
 *      only store the agent can write. It is the wrong store twice over: it is a
 *      decision rather than a recollection, so it wants review and versioning,
 *      and `filterBootstrapFilesForSession` narrows cron and subagent sessions to
 *      MINIMAL_BOOTSTRAP_ALLOWLIST (AGENTS/TOOLS/SOUL/IDENTITY/USER — no
 *      MEMORY.md), so it silently stops applying as soon as the same work runs on
 *      a schedule. The agent cannot write Instructions itself and should not be
 *      able to; drafting the wording and handing it over is the whole of what it
 *      can do, so the block tells it to do exactly that.
 */
export function buildMemoryPromptBlock(allowedTools: string[]): string | null {
  if (!allowedTools.includes("pinchy_memory")) return null;

  return [
    "## Memory",
    "You have persistent memory that survives across conversations:",
    "- **Long-term** — `MEMORY.md` holds your durable knowledge. It is the only " +
      "memory file loaded automatically at the start of a conversation, so put " +
      "the knowledge itself here, not just pointers to it.",
    "- **Topic notes** — `memory/<topic>.md` for anything too long for " +
      "`MEMORY.md`, and `memory/YYYY-MM-DD.md` for raw daily observations. These " +
      "are NOT loaded automatically; keep a one-line pointer in `MEMORY.md` for " +
      "each one so you know it exists.",
    "",
    "Write to these with your `pinchy_write` tool. When the user asks you to " +
      "remember something, actually write it; don't just say you will. When a " +
      "note is no longer true, edit it — and when nothing in it still applies, " +
      "remove the file with `pinchy_delete` rather than leaving a placeholder " +
      "behind: an emptied note stays searchable and keeps competing with the " +
      "notes that do apply. Deletion is permanent, so say what you are removing.",
    "",
    "**Before you answer** a question your memory covers, read the note that " +
      "covers it — don't answer first and check afterwards. Read with " +
      "`pinchy_read`; use `pinchy_ls` on `memory/` to find a topic note when you " +
      "don't know the filename. Your memory is also indexed for faster " +
      "`memory_search` / `memory_get`, but that index may be unavailable; if a " +
      "search returns nothing or reports it is unavailable, fall back to reading " +
      "the files. If you still can't find it, say you checked — never invent a " +
      'reason like "the index changed" and never ask the user to repeat ' +
      "something you already saved.",
    "",
    "Your identity and instructions (`SOUL.md`, `AGENTS.md`) are " +
      "platform-managed and not writable — don't try to change who you are by " +
      "editing them; use your memory instead.",
    "",
    "One exception matters: when you and the user settle on a durable way of " +
      "**working** — a rule, a scoring method, a standard procedure — that " +
      "belongs in the agent's Instructions, not in your memory. Memory is not " +
      "loaded in scheduled or background runs, so a working rule kept there " +
      "silently stops applying the moment the same work happens on a schedule. " +
      "Say so, offer to draft the exact wording, and let the user paste it into " +
      "Settings → Instructions. Keep it in memory as well until they have.",
  ].join("\n");
}
