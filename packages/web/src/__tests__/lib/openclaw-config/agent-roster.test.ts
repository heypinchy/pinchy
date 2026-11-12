import { describe, it, expect } from "vitest";
import { buildAgentsBlock, preserveTalkBlock } from "@/lib/openclaw-config/agent-roster";

const PINCHY_DEFAULTS = { compaction: { memoryFlush: { enabled: false } } };

describe("buildAgentsBlock", () => {
  it("emits the roster keyed by agent id, never the retired list", () => {
    const block = buildAgentsBlock({ list: [{ id: "old", name: "Old" }] }, PINCHY_DEFAULTS, {
      smithers: { name: "Smithers" },
    });
    expect(block.list).toBeUndefined();
    expect(block.entries).toEqual({ smithers: { name: "Smithers" } });
  });

  it("declares explicit ownership exactly when the roster has more than one agent", () => {
    // OpenClaw 2026.9 rejects a multi-agent roster without it.
    expect(
      buildAgentsBlock({}, PINCHY_DEFAULTS, { a: { name: "A" }, b: { name: "B" } }).ownership
    ).toBe("explicit");
    expect(
      buildAgentsBlock({ ownership: "explicit" }, PINCHY_DEFAULTS, { a: { name: "A" } }).ownership
    ).toBeUndefined();
  });

  it("replaces the roster wholesale, so a deleted agent does not survive in the file", () => {
    const block = buildAgentsBlock(
      { entries: { gone: { name: "Gone" }, a: { name: "A", extra: 1 } } },
      PINCHY_DEFAULTS,
      { a: { name: "A" } }
    );
    expect(block.entries).toEqual({ a: { name: "A" } });
  });

  it("leaves the roster out entirely while Pinchy has no agent", () => {
    const block = buildAgentsBlock({ entries: { main: {} } }, PINCHY_DEFAULTS, {});
    expect(block.entries).toBeUndefined();
    expect(block.ownership).toBeUndefined();
  });

  it("strips agents.defaults keys OpenClaw 2026.8 retired, keeping every other default", () => {
    const block = buildAgentsBlock(
      {
        defaults: {
          contextTokens: 262144,
          memorySearch: { provider: "local" },
          contextPruning: { mode: "cache-ttl" },
        },
      },
      PINCHY_DEFAULTS,
      { a: { name: "A" } }
    );
    expect(block.defaults).toEqual({
      contextPruning: { mode: "cache-ttl" },
      compaction: { memoryFlush: { enabled: false } },
    });
  });

  it("drops an OpenClaw roster stamp that points at an agent no longer in the roster", () => {
    const block = buildAgentsBlock(
      {
        defaults: {
          systemAgent: { agentId: "gone" },
          heartbeat: { agentId: "gone", every: "0m" },
          authInheritance: { agentId: "a" },
          sessionStore: { agentId: "gone" },
        },
      },
      PINCHY_DEFAULTS,
      { a: { name: "A" } }
    );
    const defaults = block.defaults as Record<string, unknown>;
    expect(defaults.systemAgent).toBeUndefined();
    expect(defaults.sessionStore).toBeUndefined();
    expect(defaults.heartbeat).toEqual({ every: "0m" });
    expect(defaults.authInheritance).toEqual({ agentId: "a" });
  });
  it("leaves a stamped default alone when it is not an object", () => {
    const block = buildAgentsBlock({ defaults: { heartbeat: "30m" } }, PINCHY_DEFAULTS, {
      a: { name: "A" },
    });
    expect((block.defaults as Record<string, unknown>).heartbeat).toBe("30m");
  });
});

describe("preserveTalkBlock", () => {
  it("keeps what OpenClaw wrote while its agent exists", () => {
    expect(preserveTalkBlock({ agentId: "a", voice: "x" }, new Set(["a"]))).toEqual({
      agentId: "a",
      voice: "x",
    });
  });

  it("drops the agent reference once that agent is gone", () => {
    expect(preserveTalkBlock({ agentId: "gone", voice: "x" }, new Set(["a"]))).toEqual({
      voice: "x",
    });
    expect(preserveTalkBlock({ agentId: "gone" }, new Set(["a"]))).toBeUndefined();
  });

  it("returns nothing when there was no talk block", () => {
    expect(preserveTalkBlock(undefined, new Set(["a"]))).toBeUndefined();
  });
});
