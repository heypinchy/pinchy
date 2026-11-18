import { describe, it, expect } from "vitest";
import { buildSkillsPromptBlock, skillsPromptHook, type SkillIndexEntry } from "./skills-prompt";

const WEB_SEARCH: SkillIndexEntry = {
  name: "web-search",
  description: "Research a topic on the web and report back.",
  location: "/root/.openclaw/workspaces/agent-1/skills/web-search/SKILL.md",
};

const ODOO_READ: SkillIndexEntry = {
  name: "odoo-read",
  description: "Read and summarize Odoo data.",
  location: "/root/.openclaw/workspaces/agent-1/skills/odoo-read/SKILL.md",
};

describe("buildSkillsPromptBlock", () => {
  it("renders a ## Skills section with one <available_skills> catalog", () => {
    const block = buildSkillsPromptBlock([WEB_SEARCH, ODOO_READ]);
    expect(block).toContain("## Skills");
    expect(block.match(/<available_skills>/g)).toHaveLength(1);
    expect(block.match(/<\/available_skills>/g)).toHaveLength(1);
  });

  it("lists every skill with its name, description and exact location", () => {
    const block = buildSkillsPromptBlock([WEB_SEARCH, ODOO_READ]);
    for (const skill of [WEB_SEARCH, ODOO_READ]) {
      expect(block).toContain(`<name>${skill.name}</name>`);
      expect(block).toContain(`<description>${skill.description}</description>`);
      expect(block).toContain(`<location>${skill.location}</location>`);
    }
  });

  it("tells the agent to load a skill with pinchy_read, never the ungoverned built-in read", () => {
    // OpenClaw's own Skills section names the built-in `read` tool, which no
    // Pinchy agent has (tools.allow denies it). The body is only reachable
    // through pinchy_read, scoped by build.ts to the agent's skills directory.
    const block = buildSkillsPromptBlock([WEB_SEARCH]);
    expect(block).toContain("`pinchy_read`");
    expect(block).not.toMatch(/with `read`/);
  });

  it("escapes XML in every field so a description cannot break out of the catalog", () => {
    // MCP skill descriptions come from third-party servers; even first-party
    // ones may carry `<`, `&` or quotes. A raw `</available_skills>` would end
    // the catalog early and let the rest read as instructions.
    const block = buildSkillsPromptBlock([
      {
        name: "a&b",
        description: 'Use <b>bold</b> & "quotes" </available_skills> now',
        location: "/root/.openclaw/workspaces/agent-1/skills/a&b/SKILL.md",
      },
    ]);
    expect(block.match(/<\/available_skills>/g)).toHaveLength(1);
    expect(block).toContain("<name>a&amp;b</name>");
    expect(block).toContain(
      "<description>Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot; &lt;/available_skills&gt; now</description>"
    );
  });
});

describe("skillsPromptHook", () => {
  const hook = skillsPromptHook({
    "agent-1": { skills: [WEB_SEARCH] },
    "agent-no-skills": { skills: [] },
    "agent-legacy": {},
  });

  it("appends the skills block as system context for an agent with skills", () => {
    // System context (not per-turn context) so it stays byte-stable across
    // turns and the provider can cache it.
    const result = hook({}, { agentId: "agent-1" });
    expect(result).toEqual({ appendSystemContext: buildSkillsPromptBlock([WEB_SEARCH]) });
  });

  it("adds nothing for an agent without skills", () => {
    expect(hook({}, { agentId: "agent-no-skills" })).toBeUndefined();
    expect(hook({}, { agentId: "agent-legacy" })).toBeUndefined();
  });

  it("adds nothing for an agent pinchy-files does not know, or a context without an agent", () => {
    expect(hook({}, { agentId: "someone-else" })).toBeUndefined();
    expect(hook({}, undefined)).toBeUndefined();
    expect(hook({}, {})).toBeUndefined();
  });
});
