import { describe, it, expect } from "vitest";
import { DOCUMENT_TEMPLATES } from "@/lib/agent-templates/data/document-agents";
import { KNOWLEDGE_BASE_TEMPLATES } from "@/lib/agent-templates/data/knowledge-base";
import { KNOWN_SKILLS, getSkillBody, isKnownSkill } from "@/lib/skills";
import type { AgentTemplate } from "@/lib/agent-templates/types";

/**
 * Contract for the document/knowledge-base template → skill migration (#544).
 * The workflow prose that used to be restated in every template's
 * defaultAgentsMd now lives in shared SKILL.md bodies referenced through
 * `defaultSkills`; the templates keep persona only.
 *
 * Same shape as the Odoo contract in odoo-skill-contract.test.ts (#546): the
 * guards derive the expected skill set from a template property rather than
 * from a hand-maintained list, so a new template of the same kind is covered
 * without editing this file.
 */
describe("document + knowledge-base template ↔ skill contract", () => {
  const documentEntries = Object.entries(DOCUMENT_TEMPLATES);
  const kbEntries = Object.entries(KNOWLEDGE_BASE_TEMPLATES);
  const allEntries: Array<[string, AgentTemplate]> = [...documentEntries, ...kbEntries];

  it("every document and knowledge-base template declares at least one skill", () => {
    for (const [id, t] of allEntries) {
      expect((t.defaultSkills ?? []).length, `${id} has no defaultSkills`).toBeGreaterThan(0);
    }
  });

  it("every declared skill is a KNOWN_SKILLS entry (drift guard)", () => {
    for (const [id, t] of allEntries) {
      for (const skill of t.defaultSkills ?? []) {
        expect(isKnownSkill(skill), `${id} references unknown skill "${skill}"`).toBe(true);
      }
    }
  });

  it("declared skills are unique per template (no duplicates)", () => {
    for (const [id, t] of allEntries) {
      const skills = t.defaultSkills ?? [];
      expect(new Set(skills).size, `${id} has duplicate skills`).toBe(skills.length);
    }
  });

  it("every document template carries files-search-and-read (the shared read foundation)", () => {
    for (const [id, t] of documentEntries) {
      expect(t.defaultSkills ?? [], `${id} missing files-search-and-read`).toContain(
        "files-search-and-read"
      );
    }
  });

  it("templates that evaluate documents against criteria carry document-comparison", () => {
    // contract-analyzer compares terms across agreements, resume-screener ranks
    // candidates against requirements, proposal-comparator scores vendors,
    // compliance-checker maps documents onto a standard. onboarding-guide only
    // answers questions from a corpus — nothing to score, so no comparison
    // skill (an unused skill is context the model pays for and never needs).
    const expected = [
      "compliance-checker",
      "contract-analyzer",
      "proposal-comparator",
      "resume-screener",
    ];
    const carriers = documentEntries
      .filter(([, t]) => (t.defaultSkills ?? []).includes("document-comparison"))
      .map(([id]) => id)
      .sort();
    expect(carriers).toEqual(expected);
  });

  it("knowledge-base carries knowledge-search and NOT the file-reading skill", () => {
    // Regression guard for the conflict documented in generate-agents-md.ts:
    // a "start with pinchy_ls" instruction is more specific than
    // "use knowledge_search for any question", so it wins — and the KB agent
    // walks the folder tree instead of retrieving. Reading a file returns no
    // page anchor, so the answers it produces cannot be cited at all.
    const kb = KNOWLEDGE_BASE_TEMPLATES["knowledge-base"];
    expect(kb.defaultSkills).toContain("knowledge-search");
    expect(kb.defaultSkills).not.toContain("files-search-and-read");
  });

  it("no persona restates tool or workflow prose (skills own that)", () => {
    for (const [id, t] of allEntries) {
      const md = t.defaultAgentsMd ?? "";
      expect(md, `${id} persona must not be empty`).not.toBe("");
      for (const toolName of ["pinchy_ls", "pinchy_read", "pinchy_write", "knowledge_search"]) {
        expect(md, `${id} persona names the tool "${toolName}"`).not.toContain(toolName);
      }
      expect(md.toLowerCase(), `${id} persona carries a Capabilities section`).not.toMatch(
        /##\s*capabilities/
      );
    }
  });

  it("each new skill body carries its defining content", () => {
    const anchors: Record<string, RegExp> = {
      "files-search-and-read": /pinchy_ls/,
      "document-comparison": /not stated/i,
      "knowledge-search": /knowledge_search/,
    };
    for (const [skill, anchor] of Object.entries(anchors)) {
      expect(KNOWN_SKILLS as readonly string[], `${skill} not in KNOWN_SKILLS`).toContain(skill);
      expect(getSkillBody(skill as (typeof KNOWN_SKILLS)[number]), `${skill} body`).toMatch(anchor);
    }
  });

  it("the knowledge-search skill keeps the citation contract the template used to carry", () => {
    // These four rules are the reason a KB answer is checkable. They moved out
    // of the template verbatim-in-spirit; if a future edit drops one, the
    // agent still answers — it just stops being auditable, which no other
    // test would notice.
    const body = getSkillBody("knowledge-search");
    expect(body, "inline citation numbers").toMatch(/\[1\]/);
    expect(body, "Sources list").toMatch(/\*\*Sources:\*\*/);
    expect(body, "error is not the same as zero results").toMatch(/error/i);
    expect(body, "answer in the user's language").toMatch(/language/i);
  });
});
