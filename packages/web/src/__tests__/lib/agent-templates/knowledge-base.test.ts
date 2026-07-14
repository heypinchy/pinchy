import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("knowledge-base template", () => {
  const template = AGENT_TEMPLATES["knowledge-base"];
  const md = template.defaultAgentsMd ?? "";

  it("grants the knowledge_search tool", () => {
    // The KB agent can only retrieve grounded, citable passages via this
    // tool (see pinchy-knowledge's index.ts) — without it in allowedTools
    // the plugin never registers the tool for this agent (presence-only
    // per-agent gating, see build.ts).
    expect(template.allowedTools).toContain("knowledge_search");
  });

  it("instructs the agent to search the knowledge base before answering from memory", () => {
    expect(md).toMatch(/knowledge_search/);
  });

  it("teaches cite-then-answer against the closed numbered source list", () => {
    // knowledge_search returns "[1] docName (p. page): ..." — the model must
    // cite by that number and never invent an id outside the returned set.
    expect(md).toMatch(/cite/i);
    expect(md).toMatch(/\[1\]|\[N\]|number/i);
    expect(md).toMatch(/never (cite|fabricate|invent)/i);
  });

  it("makes citations self-contained with a visible Sources list", () => {
    // The knowledge_search tool RESULT never reaches the browser — only the
    // model's own generated text does. So bare inline [1]/[2] markers are not
    // traceable unless the model restates each source's identity in its
    // visible answer (same pattern as OpenClaw's native "Source: <path>"
    // memory citations). The template must teach a trailing Sources list that
    // maps each cited number to its document name + page.
    expect(md).toMatch(/Sources:/);
    expect(md).toMatch(/document name/i);
    expect(md).toMatch(/page/i);
  });

  it("instructs the agent to answer in the user's question language", () => {
    expect(md).toMatch(/language/i);
  });

  it("teaches the abstention ladder for insufficient retrieval", () => {
    // Full miss: say so honestly instead of guessing.
    expect(md).toMatch(/couldn't find|could not find|don't (know|contain)/i);
    // Partial hit: answer what's supported and flag what's missing.
    expect(md).toMatch(/partial/i);
    // Never pad an unsupported answer.
    expect(md).toMatch(/never (pad|guess)/i);
  });

  it("teaches that a knowledge_search error is not the same as an empty knowledge base", () => {
    // The embedding model can cold-load after idle and knowledge_search can
    // return isError: true (a transport/route failure), distinct from a
    // zero-match result. Without this guidance the model paraphrases that
    // error as "the knowledge base is empty," which is false and misleads
    // the user. Regression guard: this bullet must not silently disappear.
    expect(md).toMatch(/temporarily unavailable/i);
    expect(md).toMatch(/never claim the knowledge base is empty/i);
  });
});
