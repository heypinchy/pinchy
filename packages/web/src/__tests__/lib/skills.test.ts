import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { KNOWN_SKILLS, getSkillBody, parseSkillFrontmatter, type SkillId } from "@/lib/skills";

const SKILLS_DIR = join(process.cwd(), "src/lib/skills");

describe("KNOWN_SKILLS drift guard", () => {
  // Master issue #543, Phase 0 — Pinchy's "paired list" convention.
  // Same shape as KNOWN_PINCHY_PLUGINS guarded in plugin-manifest-loader.ts:
  // the const list and the on-disk truth must agree.

  it("every KNOWN_SKILLS entry has a SKILL.md on disk", () => {
    for (const id of KNOWN_SKILLS) {
      const skillPath = join(SKILLS_DIR, id, "SKILL.md");
      expect(existsSync(skillPath), `expected SKILL.md at ${skillPath}`).toBe(true);
    }
  });

  it("every on-disk SKILL.md is listed in KNOWN_SKILLS", () => {
    const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(join(SKILLS_DIR, d.name, "SKILL.md")))
      .map((d) => d.name);

    for (const id of onDisk) {
      expect(KNOWN_SKILLS, `on-disk skill "${id}" missing from KNOWN_SKILLS`).toContain(id);
    }
  });

  it("every SKILL.md has frontmatter with name == directory name", () => {
    for (const id of KNOWN_SKILLS) {
      const skillPath = join(SKILLS_DIR, id, "SKILL.md");
      const fm = parseSkillFrontmatter(readFileSync(skillPath, "utf-8"));
      expect(fm.name, `SKILL.md ${id} frontmatter.name`).toBe(id);
      expect(fm.description, `SKILL.md ${id} frontmatter.description`).toBeTruthy();
    }
  });
});

describe("parseSkillFrontmatter", () => {
  it("extracts name + description from a minimal SKILL.md", () => {
    const md = `---
name: foo
description: A test skill.
---

# Body

Something.
`;
    expect(parseSkillFrontmatter(md)).toEqual({ name: "foo", description: "A test skill." });
  });

  it("tolerates extra single-line keys", () => {
    const md = `---
name: foo
description: A test skill.
user-invocable: false
---

Body.
`;
    expect(parseSkillFrontmatter(md).name).toBe("foo");
  });

  it("throws when frontmatter is missing", () => {
    expect(() => parseSkillFrontmatter("Just body, no frontmatter\n")).toThrow(/frontmatter/i);
  });

  it("throws when required keys are missing", () => {
    const md = `---
name: foo
---

Body.
`;
    expect(() => parseSkillFrontmatter(md)).toThrow(/description/i);
  });
});

describe("getSkillBody", () => {
  it("returns the full SKILL.md content (frontmatter + body) for a known skill", () => {
    const id = KNOWN_SKILLS[0];
    const body = getSkillBody(id);
    expect(body).toContain("---");
    expect(body).toContain(`name: ${id}`);
    expect(body.length).toBeGreaterThan(100);
  });

  it("throws for an unknown skill id", () => {
    expect(() => getSkillBody("does-not-exist" as SkillId)).toThrow(/unknown skill/i);
  });
});
