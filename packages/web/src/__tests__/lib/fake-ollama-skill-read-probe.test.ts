// Unit coverage for the fake-LLM's skill-read probe (e2e/web/web-search.spec.ts).
// The probe reads the first <location> out of the real `## Skills` block that
// pinchy-files puts into the system prompt. That block's guidance text also
// names `<location>`, so a wording change there could break the probe — and the
// E2E that would notice runs in CI only. These tests feed the real block in.
import { describe, expect, it } from "vitest";
import { buildSkillsPromptBlock } from "../../../../plugins/pinchy-files/skills-prompt";
import {
  skillReadProbeReply,
  FAKE_OLLAMA_SKILL_READ_PROBE_DONE,
  FAKE_OLLAMA_SKILL_READ_PROBE_NO_SKILLS,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

const LOCATION = "/root/.openclaw/workspaces/agent-1/skills/web-search/SKILL.md";
const system = {
  role: "system",
  content: buildSkillsPromptBlock([
    { name: "web-search", description: "Research the web.", location: LOCATION },
  ]),
};
const user = { role: "user", content: "E2E_SKILL_READ_PROBE: which skills?" };

describe("skillReadProbeReply", () => {
  it("reads the catalog's location with pinchy_read, not the guidance text's", () => {
    expect(skillReadProbeReply([system, user], false)).toEqual({
      toolCall: { name: "pinchy_read", arguments: { path: LOCATION } },
    });
  });

  it("finds the catalog in a developer-role system prompt too", () => {
    expect(skillReadProbeReply([{ ...system, role: "developer" }, user], false)).toEqual({
      toolCall: { name: "pinchy_read", arguments: { path: LOCATION } },
    });
  });

  it("answers DONE once a tool result came back", () => {
    expect(skillReadProbeReply([system, user], true)).toEqual({
      text: FAKE_OLLAMA_SKILL_READ_PROBE_DONE,
    });
  });

  it("says so when no skill is listed in the prompt", () => {
    expect(
      skillReadProbeReply([{ role: "system", content: "You are helpful." }, user], false)
    ).toEqual({ text: FAKE_OLLAMA_SKILL_READ_PROBE_NO_SKILLS });
  });
});
