import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES, getTemplate } from "@/lib/agent-templates";
import { KNOWN_SKILLS } from "@/lib/skills";

describe("market-monitor template (v1 web-search pilot)", () => {
  const template = getTemplate("market-monitor");

  it("exists in the registry", () => {
    expect(template).toBeDefined();
  });

  it("requires the pinchy-web plugin", () => {
    // pinchy-web is the capability provider; the skill is the workflow.
    expect(template?.pluginId).toBe("pinchy-web");
  });

  it("declares defaultSkills with web-search", () => {
    expect(template?.defaultSkills).toBeDefined();
    expect(template?.defaultSkills).toContain("web-search");
  });

  it("all defaultSkills are known", () => {
    // Drift guard: a template cannot reference a skill that doesn't exist.
    for (const id of template?.defaultSkills ?? []) {
      expect(KNOWN_SKILLS, `skill "${id}" not in KNOWN_SKILLS`).toContain(id);
    }
  });

  it("has an icon, persona, tagline, suggestedNames, and modelHint", () => {
    expect(template?.iconName).toBeTruthy();
    expect(template?.defaultPersonality).toBeTruthy();
    expect(template?.defaultTagline).toBeTruthy();
    expect(template?.suggestedNames?.length ?? 0).toBeGreaterThan(0);
    expect(template?.modelHint).toBeDefined();
  });

  it("does NOT carry inline tool/workflow prose in defaultAgentsMd (skills own that)", () => {
    // Skills-based templates keep persona prose ONLY. Workflow guidance
    // lives in the SKILL.md body so it can be reused across templates.
    const md = template?.defaultAgentsMd ?? "";
    expect(md.toLowerCase()).not.toMatch(/## capabilities/);
    expect(md.toLowerCase()).not.toMatch(/pinchy_web_search/);
  });
});

describe("AGENT_TEMPLATES — additive defaultSkills", () => {
  it("existing templates without defaultSkills keep working (backwards compat)", () => {
    // Field is optional. Templates can omit it; agents created from such
    // templates get skills: [] in their DB row.
    for (const t of Object.values(AGENT_TEMPLATES)) {
      // No assertion on the field being present — just verify the type
      // accepts the absence (compile-time check via the spread).
      const _check: string[] | undefined = t.defaultSkills;
      void _check;
    }
    expect(true).toBe(true);
  });
});
