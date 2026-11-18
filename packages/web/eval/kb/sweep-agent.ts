/**
 * Which agent the Layer-3 sweep measures.
 *
 * A constant in its own module, not a literal in the spec, so the methodology
 * invariant it carries can be asserted by a unit test that does not need
 * Playwright, a stack, or an API key — see
 * `src/__tests__/lib/eval/kb-sweep-template.test.ts`.
 */

/**
 * The sweep measures the shipped **Knowledge Base** template, instructions and
 * all — not a bare `custom` agent (#869 item 4).
 *
 * `custom` has `defaultAgentsMd: null`: no cite-then-answer rule, no Sources
 * list, no closed-set constraint. Grading its answers against the cited-answer
 * contract measured whether a model invents that contract unprompted, which is
 * not a groundedness property and not something any Pinchy user is exposed to.
 * The first sweep read `passRate 0` for capable models on `ungrounded-claim`
 * and `citation-unresolved` for exactly that reason — a setup artifact wearing
 * the costume of a quality signal.
 *
 * The graders encode the cited-answer contract clause for clause, so the agent
 * under test has to be the one that carries it. Since the skill-layer
 * migration (#543/#544) that contract is delivered by the `knowledge-search`
 * SKILL.md the template declares, not by its `defaultAgentsMd` — which is why
 * the accompanying test reads the union of both rather than one file. Keeping
 * them pinned together is what that test is for: if the contract disappears
 * from everything the agent is told, the sweep stops measuring what it claims
 * to and the test says so.
 */
export const KB_SWEEP_TEMPLATE_ID = "knowledge-base";

/** The `/data` mount the eval corpus is seeded under. */
export const KB_SWEEP_CORPUS_ROOT = "/data";

/** The single tool the sweep grants — and the one its audit probe reads. */
export const KB_SWEEP_ALLOWED_TOOLS = ["knowledge_search"];

/**
 * The body `POST /api/agents` needs to create the sweep agent.
 *
 * `pluginConfig` belongs in the CREATE call, not only in the PATCH that
 * follows: the route rejects a `pinchy-files` template with no
 * `allowed_paths` at creation time ("At least one directory must be
 * selected"), and the KB template is a `pinchy-files` template. The bare
 * `custom` agent this sweep used to create carries no `pluginId`, so the
 * check never applied and the omission was invisible until the template
 * switch (#869 item 4) turned it into a 400 on the sweep's first live run.
 *
 * `agents-create.test.ts` puts this exact body through the real route
 * handler, which is the only way to check the claim without re-stating the
 * route's rules in a test that would then drift from them.
 */
export function buildKbSweepAgentPayload(name: string) {
  return {
    name,
    templateId: KB_SWEEP_TEMPLATE_ID,
    pluginConfig: { "pinchy-files": { allowed_paths: [KB_SWEEP_CORPUS_ROOT] } },
  };
}

/**
 * Which of the template's skills the freshly-created agent did NOT receive.
 *
 * The contract the graders enforce is delivered by a SKILL.md since the
 * skill-layer migration, so "the agent carries the template's skills" is the
 * sweep's measurement premise — and the one link in the chain that no test
 * covers, because every other link is checked against a mock:
 * `kb-sweep-template.test.ts` proves the skill body states the clauses,
 * `agents-create.test.ts` proves the route copies `defaultSkills` onto the
 * row, and `build.ts` materializes the file. None of them observes the agent
 * this run will actually measure.
 *
 * That gap is not theoretical. The first sweep measured an agent with no
 * instructions whatsoever and published `passRate 0` for it (#869 item 4) —
 * a premise that failed silently, in a run that looked like it worked.
 *
 * Derived from the template rather than a hard-coded list, so a skill added to
 * the template is checked without touching this file.
 */
export function missingSweepSkills(
  templateSkills: readonly string[] | undefined,
  agentSkills: readonly string[] | null | undefined
): string[] {
  const carried = new Set(agentSkills ?? []);
  return (templateSkills ?? []).filter((id) => !carried.has(id));
}
