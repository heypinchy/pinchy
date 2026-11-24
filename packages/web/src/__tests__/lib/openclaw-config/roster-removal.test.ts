// OpenClaw 2026.9 refuses any config write that drops an agent from its roster
// ("Config write would drop agent roster entries without an explicit
// deletion: <ids>") — only its own agents.delete may remove one. Pinchy
// replaces the roster wholesale on every regenerate, so a deleted agent, and
// on a fresh install the implicit "main" agent OpenClaw assumes for a file
// with no roster, reach it as exactly such a write. These helpers read what
// OpenClaw refused and build the write that keeps it until agents.delete
// removes it.
import { describe, it, expect } from "vitest";
import {
  parseRosterDropRejection,
  retainRosterEntries,
} from "@/lib/openclaw-config/roster-removal";

const gw = { mode: "local" };

describe("parseRosterDropRejection", () => {
  it("reads the agent ids from OpenClaw's refusal", () => {
    // Worded as OpenClaw 2026.9.2's assertCanonicalAgentRosterRetainsEntries
    // throws it, and as config.apply relays it.
    expect(
      parseRosterDropRejection(
        "Config write would drop agent roster entries without an explicit deletion: main."
      )
    ).toEqual(["main"]);
    expect(
      parseRosterDropRejection(
        "invalid config: Config write would drop agent roster entries without an explicit deletion: agent-1, kb-2."
      )
    ).toEqual(["agent-1", "kb-2"]);
  });

  it("is undefined for any other error", () => {
    expect(parseRosterDropRejection("rate limit exceeded for config.apply; retry after 3s")).toBe(
      undefined
    );
    expect(
      parseRosterDropRejection(
        "Config write would drop agent roster entries without an explicit deletion: "
      )
    ).toBe(undefined);
  });
});

describe("retainRosterEntries", () => {
  it("adds the dropped agents back as OpenClaw holds them, with explicit ownership", () => {
    const oc = {
      agents: {
        ownership: "explicit",
        entries: { a: { name: "A" }, gone: { name: "Gone", model: "x/y" } },
      },
    };
    const payload = {
      gateway: gw,
      agents: { defaults: { d: 1 }, entries: { a: { name: "A2" }, b: { name: "B" } } },
    };

    const bridge = retainRosterEntries(payload, oc, ["gone"]);

    expect(bridge).toEqual({
      gateway: gw,
      agents: {
        defaults: { d: 1, authInheritance: { agentId: "a" } },
        ownership: "explicit",
        entries: { a: { name: "A2" }, b: { name: "B" }, gone: { name: "Gone", model: "x/y" } },
      },
    });
    // The payload itself is left alone: it is what lands after the deletion.
    expect(payload.agents).not.toHaveProperty("ownership");
  });

  it("hands the inherited-credential role to an agent that stays", () => {
    // OpenClaw 2026.9's agents.delete refuses the agent that owns
    // agents.defaults.authInheritance — the role a roster write pins to the
    // agent a sole-agent roster held. Pinchy keeps no auth profiles (provider
    // keys reach OpenClaw as SecretRefs), so the role carries nothing for it.
    const oc = { agents: { entries: { a: { name: "A" } } } };
    const bridge = retainRosterEntries({ agents: { entries: { b: { name: "B" } } } }, oc, ["a"]);
    expect((bridge.agents as { defaults: unknown }).defaults).toEqual({
      authInheritance: { agentId: "b" },
    });
  });

  it("leaves the inherited-credential role with an agent that stays", () => {
    const payload = {
      agents: {
        defaults: { authInheritance: { agentId: "c" } },
        entries: { b: {}, c: {} },
      },
    };
    const bridge = retainRosterEntries(payload, { agents: { entries: { a: {}, b: {}, c: {} } } }, [
      "a",
    ]);
    expect((bridge.agents as { defaults: unknown }).defaults).toEqual({
      authInheritance: { agentId: "c" },
    });
  });

  it("keeps the implicit main as an empty entry", () => {
    const bridge = retainRosterEntries(
      { agents: { entries: { s: { name: "S" } } } },
      { gateway: gw },
      ["main"]
    );
    expect(bridge.agents).toEqual({
      defaults: { authInheritance: { agentId: "s" } },
      ownership: "explicit",
      entries: { s: { name: "S" }, main: {} },
    });
  });

  it("takes a dropped agent from a roster OpenClaw has not migrated yet", () => {
    const oc = {
      agents: {
        list: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      },
    };
    const bridge = retainRosterEntries({ agents: { entries: { a: {} } } }, oc, ["b"]);
    expect(bridge.agents).toEqual({
      defaults: { authInheritance: { agentId: "a" } },
      ownership: "explicit",
      entries: { a: {}, b: { name: "B" } },
    });
  });
});
