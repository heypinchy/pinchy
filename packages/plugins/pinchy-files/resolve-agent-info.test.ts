// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resolveAgentInfo } from "./resolve-agent-info";

describe("resolveAgentInfo", () => {
  it("returns both name and model when the agent exists in the config", () => {
    // The plugin needs BOTH name and model from the same cfg walk: the model
    // drives vision API calls, the name makes the Usage Dashboard readable
    // (without it, rows just show the opaque agent ID).
    const cfg = {
      agents: {
        list: [
          {
            id: "agent-1",
            name: "Knowledge Base",
            model: "anthropic/claude-haiku-4-5-20251001",
          },
        ],
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({
      name: "Knowledge Base",
      model: "anthropic/claude-haiku-4-5-20251001",
    });
  });

  it("returns undefined fields when the agent is not in the list", () => {
    const cfg = {
      agents: {
        list: [{ id: "other-agent", name: "Other", model: "some-model" }],
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({
      name: undefined,
      model: undefined,
    });
  });

  it("returns undefined fields when cfg has no agents at all", () => {
    expect(resolveAgentInfo({}, "agent-1")).toEqual({
      name: undefined,
      model: undefined,
    });
  });

  it("returns undefined fields when cfg is null or undefined", () => {
    expect(resolveAgentInfo(null, "agent-1")).toEqual({
      name: undefined,
      model: undefined,
    });
    expect(resolveAgentInfo(undefined, "agent-1")).toEqual({
      name: undefined,
      model: undefined,
    });
  });

  it("returns only name when model is missing on the matched agent", () => {
    const cfg = {
      agents: {
        list: [{ id: "agent-1", name: "Knowledge Base" }],
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({
      name: "Knowledge Base",
      model: undefined,
    });
  });

  it("returns only model when name is missing on the matched agent", () => {
    const cfg = {
      agents: {
        list: [{ id: "agent-1", model: "anthropic/claude-haiku-4-5-20251001" }],
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({
      name: undefined,
      model: "anthropic/claude-haiku-4-5-20251001",
    });
  });

  it("reads the agent from OpenClaw 2026.9's keyed agents.entries", () => {
    // 2026.9 stores agents under agents.entries, keyed by id. Its runtime
    // config still attaches a non-enumerable agents.list projection, but any
    // copy of the config (a spread, a JSON round trip) loses it, so the keyed
    // roster is the one to read.
    const cfg = {
      agents: {
        entries: {
          "agent-1": { name: "Knowledge Base", model: "anthropic/claude-haiku-4-5-20251001" },
          "agent-2": { name: "Other", model: "some-model" },
        },
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({
      name: "Knowledge Base",
      model: "anthropic/claude-haiku-4-5-20251001",
    });
  });

  it("takes the primary model when the entry carries a model with fallbacks", () => {
    const cfg = {
      agents: {
        entries: {
          "agent-1": {
            name: "Knowledge Base",
            model: { primary: "anthropic/claude-haiku-4-5-20251001", fallbacks: ["openai/gpt-5"] },
          },
        },
      },
    };

    expect(resolveAgentInfo(cfg, "agent-1").model).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("returns undefined fields when the agent is not in agents.entries", () => {
    const cfg = { agents: { entries: { other: { name: "Other", model: "m" } } } };

    expect(resolveAgentInfo(cfg, "agent-1")).toEqual({ name: undefined, model: undefined });
  });
});
