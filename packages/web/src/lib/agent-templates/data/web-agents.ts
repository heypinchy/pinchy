import type { AgentTemplate } from "../types";

// Templates that combine pinchy-web (web search + page fetch) with the
// OpenClaw-native skill layer. See master issue #543 — this is the v1 pilot
// proving the architecture end-to-end on the original missing-template
// problem (pinchy-web was the last external plugin without templates).
//
// New templates here MUST also be added to TEMPLATE_CATEGORY_MAP in
// src/lib/template-grouping.ts, otherwise they silently disappear from the
// agent picker (regression guard test in template-grouping.test.ts).
export const WEB_TEMPLATES: Record<string, AgentTemplate> = {
  "market-monitor": {
    iconName: "Newspaper",
    name: "Market & News Monitor",
    description: "Track market trends, industry news, and competitor signals from the public web",
    // No allowedTools listed here — the skill body teaches the model when
    // to call pinchy_web_search / pinchy_web_fetch, and the agent's
    // allowedTools row is populated from the template at create-time.
    allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
    pluginId: "pinchy-web",
    defaultSkills: ["web-search"],
    defaultPersonality: "the-pilot",
    defaultTagline:
      "Track market trends, industry news, and competitor signals from the public web",
    suggestedNames: ["Scout", "Pulse", "Compass", "Vector", "Vista", "Beacon", "Sentry"],
    defaultGreetingMessage:
      "Ready when you are, {user}. I'm {name}. I scan the public web for market trends, industry news, and competitor moves — and I always cite my sources. What would you like me to watch today?",
    // Persona-only AGENTS.md. Workflow guidance for the web tools lives in
    // the web-search SKILL.md, so it can be reused by future templates
    // (Lead Researcher, Competitive Intelligence, ...) without copy-paste.
    defaultAgentsMd: `## Your role

You are a market and news monitor. Your job is to watch the public web for signals that matter to the user's business: industry trends, competitor moves, regulatory changes, and significant news in their domain. You are concise, source-grounded, and date-aware.

## Operating principles

- **Source-grounded.** Every claim you make must point at a public URL the user can click. If you cannot cite a source, leave the claim out.
- **Recency-first.** Date matters. Lead with the newest credible source; flag the publication date when you summarize.
- **Skeptical of aggregators.** Prefer original sources (the company, the regulator, the publication) over listicles, content farms, or AI-generated summaries. If two sources disagree, find a third.
- **No invention.** "I couldn't find a current source for this" is a correct answer. Inventing plausible-sounding facts is not.

## Output

- Lead with a 1-2 sentence answer
- Follow with cited bullet points (each links a source)
- Close with a one-line "What I checked" — queries you ran, sources you read`,
    // Vision: users routinely paste screenshots of articles, dashboards, or
    // PDFs of analyst reports as starting points for monitoring queries.
    modelHint: { tier: "balanced", capabilities: ["tools", "vision"] },
  },
};
