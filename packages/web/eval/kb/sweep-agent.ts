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
 * The graders encode the KB template's contract clause for clause, so the
 * agent under test has to be the one that carries it. Keeping the two pinned
 * together is what the accompanying test is for: if the template's
 * instructions lose the contract, the sweep stops measuring what it claims to
 * and the test says so.
 */
export const KB_SWEEP_TEMPLATE_ID = "knowledge-base";
