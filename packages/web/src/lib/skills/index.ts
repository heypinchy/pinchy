import { readFileSync } from "fs";
import { join } from "path";

// Pinchy first-party skills. Each entry must have a SKILL.md at
// src/lib/skills/<id>/SKILL.md with a frontmatter `name: <id>` and a
// non-empty `description`. The drift-guard test in
// __tests__/lib/skills.test.ts enforces the const list ↔ on-disk truth
// invariant. See master issue #543 for the broader rationale.
export const KNOWN_SKILLS = ["web-search"] as const;

export type SkillId = (typeof KNOWN_SKILLS)[number];

export function isKnownSkill(id: string): id is SkillId {
  return (KNOWN_SKILLS as readonly string[]).includes(id);
}

const SKILLS_DIR = join(__dirname);

export function getSkillBody(id: SkillId): string {
  if (!isKnownSkill(id)) {
    throw new Error(`unknown skill: ${id}`);
  }
  // Resolve from the compiled location too — in production this file lives
  // alongside the per-skill subdirectories under `lib/skills/`.
  const path = join(SKILLS_DIR, id, "SKILL.md");
  return readFileSync(path, "utf-8");
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

// Minimal frontmatter parser for OpenClaw-style SKILL.md.
// OC docs are explicit: "The frontmatter parser supports single-line keys
// only." So we don't need YAML — a 5-line regex over the `---`-delimited
// header block is exact and dependency-free.
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("missing frontmatter (no `---` delimited header block)");
  }

  const header = match[1];
  const entries: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (!kv) continue;
    entries[kv[1]] = kv[2];
  }

  if (!entries.name) {
    throw new Error("frontmatter missing required key: name");
  }
  if (!entries.description) {
    throw new Error("frontmatter missing required key: description");
  }

  return { name: entries.name, description: entries.description };
}
