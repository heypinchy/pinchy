import { describe, it, expect } from "vitest";
import { RESTART_CLASS_PATHS, isRestartClassDiff } from "@/lib/openclaw-config/restart-class";

describe("RESTART_CLASS_PATHS", () => {
  it("contains the canonical OC 5.3 BASE_RELOAD_RULES_TAIL paths", () => {
    // Mirrors the kind:"restart" rules in OC's reload subsystem. Any change to
    // these top-level blocks triggers a full gateway restart (SIGUSR1 → in-
    // process restart). Documented in seedRestartClassOverridesIfMissing in
    // targeted.ts. If OC adds new restart-class blocks in a future release,
    // add them here AND update this assertion to keep the drift-guard honest.
    expect(RESTART_CLASS_PATHS).toEqual([
      "gateway",
      "discovery",
      "canvasHost",
      "update",
      "channels",
      "bindings",
    ]);
  });
});

describe("isRestartClassDiff", () => {
  it("returns false when both configs are empty", () => {
    expect(isRestartClassDiff({}, {})).toBe(false);
  });

  it("returns false when only non-restart-class fields differ", () => {
    const oldCfg = {
      gateway: { mode: "local" },
      agents: { list: [{ id: "a" }] },
      models: { providers: { anthropic: {} } },
      plugins: { allow: ["pinchy-files"] },
    };
    const newCfg = {
      gateway: { mode: "local" },
      agents: { list: [{ id: "b" }] }, // changed
      models: { providers: { anthropic: { models: ["m1"] } } }, // changed
      plugins: { allow: ["pinchy-files", "pinchy-context"] }, // changed
    };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(false);
  });

  it("returns true when gateway changes (controlUi enabled flip)", () => {
    const oldCfg = { gateway: { mode: "local", controlUi: { enabled: true } } };
    const newCfg = { gateway: { mode: "local", controlUi: { enabled: false } } };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when channels block is added", () => {
    const oldCfg = { gateway: { mode: "local" } };
    const newCfg = {
      gateway: { mode: "local" },
      channels: { telegram: { enabled: true } },
    };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when channels block is removed", () => {
    const oldCfg = {
      gateway: { mode: "local" },
      channels: { telegram: { enabled: true } },
    };
    const newCfg = { gateway: { mode: "local" } };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when discovery mode changes (mdns on/off)", () => {
    const oldCfg = { discovery: { mdns: { mode: "lan" } } };
    const newCfg = { discovery: { mdns: { mode: "off" } } };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when canvasHost changes", () => {
    const oldCfg = { canvasHost: { enabled: true } };
    const newCfg = { canvasHost: { enabled: false } };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when update.checkOnStart changes", () => {
    const oldCfg = { update: { checkOnStart: true } };
    const newCfg = { update: { checkOnStart: false } };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns true when bindings (channel-to-agent map) changes", () => {
    const oldCfg = {
      bindings: [{ agentId: "a-1", match: { channel: "telegram", accountId: "a-1" } }],
    };
    const newCfg = {
      bindings: [
        { agentId: "a-1", match: { channel: "telegram", accountId: "a-1" } },
        { agentId: "a-2", match: { channel: "telegram", accountId: "a-2" } },
      ],
    };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(true);
  });

  it("returns false when nested non-restart-class paths differ within identical restart-class blocks", () => {
    const same = { mode: "local", controlUi: { enabled: false } };
    const oldCfg = {
      gateway: same,
      agents: { list: [{ id: "a", model: "m1" }] },
    };
    const newCfg = {
      gateway: same,
      agents: { list: [{ id: "a", model: "m2" }] }, // hot-reload-only
    };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(false);
  });

  it("treats deep object reordering as equal (key order doesn't matter)", () => {
    const oldCfg = {
      gateway: { mode: "local", bind: "lan", controlUi: { enabled: false } },
    };
    const newCfg = {
      gateway: { controlUi: { enabled: false }, bind: "lan", mode: "local" },
    };
    expect(isRestartClassDiff(oldCfg, newCfg)).toBe(false);
  });
});
