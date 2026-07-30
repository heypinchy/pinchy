/**
 * The Layer-3 sweep's methodology invariant: **the agent under test must be
 * instructed to do what the graders grade** (#869 item 4).
 *
 * The sweep used to create a `templateId: "custom"` agent, whose
 * `defaultAgentsMd` is `null` — no cite-then-answer rule, no Sources list, no
 * closed-set constraint. Its answers were then graded against the cited-answer
 * contract, so capable models scored `passRate 0` on `ungrounded-claim` and
 * `citation-unresolved`. That is not a groundedness measurement; it measures
 * whether a model invents an unstated contract, which no Pinchy user depends
 * on because every KB agent ships with the instructions.
 *
 * A test that only asserted `KB_SWEEP_TEMPLATE_ID === "knowledge-base"` would
 * pin the string and miss the point: the contract could be edited out of the
 * template tomorrow and the sweep would go on reporting groundedness numbers
 * for an agent that was never told to cite. So the assertions below read the
 * rendered instructions and check the clauses the graders actually enforce.
 */

import { describe, expect, it } from "vitest";

import { getTemplate } from "@/lib/agent-templates/registry";
import { generateAgentsMd } from "@/lib/agent-templates/generate-agents-md";

import { KB_SWEEP_TEMPLATE_ID } from "../../../../eval/kb/sweep-agent";

const CORPUS_ROOT = "/data/kb-eval-corpus";
const PLUGIN_CONFIG = { "pinchy-files": { allowed_paths: [CORPUS_ROOT] } };

function sweepInstructions(): string {
  const template = getTemplate(KB_SWEEP_TEMPLATE_ID);
  expect(
    template,
    `KB_SWEEP_TEMPLATE_ID "${KB_SWEEP_TEMPLATE_ID}" is not a known template`
  ).toBeDefined();

  const agentsMd = generateAgentsMd(template!, PLUGIN_CONFIG);
  expect(
    agentsMd,
    `The sweep agent's template has no instructions at all. Grading its answers ` +
      `against the cited-answer contract measures nothing about groundedness.`
  ).not.toBeNull();

  return agentsMd!;
}

describe("the Layer-3 sweep agent is instructed to do what the graders grade", () => {
  it("uses a template that exists and carries instructions", () => {
    expect(sweepInstructions().length).toBeGreaterThan(0);
  });

  it("grants knowledge_search — the one tool the sweep's audit probe reads", () => {
    const template = getTemplate(KB_SWEEP_TEMPLATE_ID);

    expect(template?.allowedTools).toContain("knowledge_search");
  });

  it("instructs inline numbered citations (the premise of citation-unresolved)", () => {
    const md = sweepInstructions();

    expect(md).toMatch(/cite/i);
    expect(md).toMatch(/\[1\]/);
  });

  it("instructs a Sources list (the premise of source-uncited and sources-format)", () => {
    const md = sweepInstructions();

    expect(md).toMatch(/Sources/);
    expect(md).toMatch(/bullet/i);
  });

  it("instructs that inline citations and the Sources list match exactly", () => {
    const md = sweepInstructions();

    expect(md).toMatch(/no more and no fewer/i);
  });

  it("instructs the document path and its position per entry (the premise of path-not-cited)", () => {
    const md = sweepInstructions();

    expect(md).toMatch(/document path/i);
    expect(md).toMatch(/position/i);
  });

  it("instructs answering only from the returned sources (the premise of ungrounded-claim)", () => {
    const md = sweepInstructions();

    expect(md).toMatch(/only using the numbered sources/i);
    expect(md).toMatch(/never fabricate/i);
  });

  it("renders the corpus root, so the agent knows where its documents are", () => {
    expect(sweepInstructions()).toContain(CORPUS_ROOT);
  });

  it("discriminates: the bare custom template would fail every assertion above", () => {
    // The guard is only worth having if it would have caught the original
    // setup. `custom` is what the sweep used, and it carries no instructions
    // whatsoever — `generateAgentsMd` returns null rather than a weaker
    // prompt, so there is nothing for a model to follow.
    const custom = getTemplate("custom");

    expect(custom).toBeDefined();
    expect(generateAgentsMd(custom!, PLUGIN_CONFIG)).toBeNull();
  });
});
