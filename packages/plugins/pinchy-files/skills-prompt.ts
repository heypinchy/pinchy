/**
 * The `## Skills` catalog, and the `before_prompt_build` hook that puts it into
 * every turn of an agent with skills.
 *
 * Why Pinchy builds this and not OpenClaw: since 2026.9, OpenClaw renders its
 * own skills section only when the built-in `read` tool is visible to the agent
 * (`system-prompt-params`: `visibleTools.has("read")`), because that section
 * tells the model to load a skill with `read`. No Pinchy agent has `read` —
 * `tools.allow` denies it so every file access goes through pinchy-files'
 * governed, audited tools. So after the 2026.9 bump no skill reached any agent,
 * and even before it the bodies were unreachable: the old section named a tool
 * the agent could not call.
 *
 * Granting `read` back is not the fix: its access is not scoped by
 * `allowed_paths`, and a guard hook in front of it would fail open the day the
 * hook did not load. This catalog fails closed instead — if pinchy-files is
 * missing, the agent simply has no skills.
 *
 * The shape mirrors OpenClaw's own `<available_skills>` catalog (name,
 * description, location) so a model trained on that format reads it the same
 * way, and keeps progressive disclosure: only the index is in the prompt, the
 * body is loaded on demand with `pinchy_read`. build.ts puts `<workspace>/skills`
 * into the agent's `allowed_paths` — never its `write_paths` — so that read
 * works and nothing else opens up.
 *
 * Returned as system context so it stays byte-stable across turns for prompt
 * caching. This module has no imports, like memory-prompt.ts.
 */

/** One entry of an agent's skill index, as build.ts emits it. */
export interface SkillIndexEntry {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md inside the agent's workspace. */
  location: string;
}

/**
 * Descriptions can come from third-party MCP servers. Escaping keeps a stray
 * `</available_skills>` from ending the catalog early and turning the rest of
 * a description into free-standing prompt text.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSkillsPromptBlock(skills: SkillIndexEntry[]): string {
  const catalog = skills.map((skill) =>
    [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.location)}</location>`,
      "  </skill>",
    ].join("\n")
  );
  return [
    "## Skills",
    "Before replying, scan the skills listed below. If one clearly " +
      "applies to the task, load its instructions with `pinchy_read` on the " +
      "exact path in its <location>, then follow them. If several could apply, " +
      "choose the most specific one. Load at most one skill up front, and only " +
      "after you have picked it. If none clearly applies, don't load any. Never " +
      "guess a skill path — use the <location> as written.",
    "<available_skills>",
    ...catalog,
    "</available_skills>",
  ].join("\n");
}

/** The slice of a pinchy-files agent config this hook reads. */
export interface SkillsPromptAgentConfig {
  skills?: SkillIndexEntry[];
}

/** What OpenClaw passes a `before_prompt_build` handler as its context. */
export interface SkillsPromptHookContext {
  agentId?: string;
}

export function skillsPromptHook(
  agentConfigs: Record<string, SkillsPromptAgentConfig>
): (
  event: unknown,
  ctx: SkillsPromptHookContext | undefined
) => { appendSystemContext: string } | undefined {
  return (_event, ctx) => {
    const agentId = ctx?.agentId;
    const skills = agentId ? agentConfigs[agentId]?.skills : undefined;
    if (!skills || skills.length === 0) return undefined;
    return { appendSystemContext: buildSkillsPromptBlock(skills) };
  };
}
