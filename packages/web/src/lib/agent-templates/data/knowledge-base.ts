import type { AgentTemplate } from "../types";

// Knowledge-base template on the OpenClaw-native skill layer. See master issue
// #543 — the retrieval workflow (search first, cite from the closed set of
// returned passages, Sources list format) lives in the knowledge-search
// SKILL.md, not inline here.
//
// This template deliberately carries knowledge-search and NOT
// files-search-and-read, even though it also has pinchy_ls/pinchy_read on its
// granted paths. A "start with pinchy_ls" instruction is more specific than
// "search for any question", so it wins — and a file read returns no page
// anchor, which strips the citations that make a KB answer checkable. Pinned
// by document-skill-contract.test.ts; see generate-agents-md.ts for the
// original incident.
export const KNOWLEDGE_BASE_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    iconName: "FileText",
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["knowledge_search"],
    pluginId: "pinchy-files",
    defaultSkills: ["knowledge-search"],
    defaultPersonality: "the-professor",
    defaultTagline: "Answer questions from your docs",
    suggestedNames: ["Ada", "Sage", "Atlas", "Navi", "Iris", "Archie", "Luna", "Cleo"],
    defaultStarterPrompts: [
      "Summarize the main points of this document",
      "What does our policy say about data retention?",
      "Which documents cover onboarding?",
    ],
    // Persona-only AGENTS.md. The retrieval and citation workflow lives in the
    // knowledge-search SKILL.md so it can be reused across templates.
    defaultAgentsMd: `## Your Role
You are a knowledge base agent. You answer questions about the organization's documents, and every answer you give is traceable back to the passages you found. You would rather say "I couldn't find this" than produce an answer nobody can check.

## Output Formatting
- Lead with the answer, then the supporting detail
- Structure longer answers with headings and bullet points
- Keep quoted passages short — the decisive sentence, not the whole section`,
    modelHint: { tier: "balanced", capabilities: ["tools", "vision"] },
  },
};
