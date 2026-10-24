import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSettingsByKeysMock, setSettingMock } = vi.hoisted(() => ({
  getSettingsByKeysMock: vi.fn(),
  setSettingMock: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getSettingsByKeys: getSettingsByKeysMock,
  setSetting: setSettingMock,
}));

import {
  getInstancePolicy,
  setInstancePolicy,
  isPolicyKey,
  isPausedPersonalAgent,
  arePersonalAutomationsPaused,
  arePersonalAutomationsPausedFor,
  POLICY_KEYS,
} from "@/lib/instance-policy";

const ON = { memberPersonalAgents: true, memberAutomations: true };

describe("getInstancePolicy", () => {
  beforeEach(() => {
    getSettingsByKeysMock.mockReset();
    setSettingMock.mockReset();
  });

  it("reads both switches as on when no key was ever written, so an upgrade changes nothing", async () => {
    getSettingsByKeysMock.mockResolvedValue(new Map());
    await expect(getInstancePolicy()).resolves.toEqual(ON);
    // Exactly its own two keys: this runs on every member navigation, API call
    // and socket frame to a personal agent, so it must not read (and ship
    // across the wire) the whole settings table with every secret in it.
    expect(getSettingsByKeysMock).toHaveBeenCalledWith([
      POLICY_KEYS.memberPersonalAgents,
      POLICY_KEYS.memberAutomations,
    ]);
  });

  it("reads an explicit 'false' as off", async () => {
    getSettingsByKeysMock.mockResolvedValue(
      new Map([
        [POLICY_KEYS.memberPersonalAgents, "false"],
        [POLICY_KEYS.memberAutomations, "false"],
      ])
    );
    await expect(getInstancePolicy()).resolves.toEqual({
      memberPersonalAgents: false,
      memberAutomations: false,
    });
  });

  it("reads a value it does not recognise as off — a restriction must not fail open", async () => {
    getSettingsByKeysMock.mockResolvedValue(new Map([[POLICY_KEYS.memberPersonalAgents, "no"]]));
    await expect(getInstancePolicy()).resolves.toEqual({
      memberPersonalAgents: false,
      memberAutomations: true,
    });
  });
});

describe("setInstancePolicy", () => {
  beforeEach(() => setSettingMock.mockReset());

  it("writes both switches as plain, unencrypted 'true'/'false' strings", async () => {
    await setInstancePolicy({ memberPersonalAgents: false, memberAutomations: true });
    expect(setSettingMock).toHaveBeenCalledWith(POLICY_KEYS.memberPersonalAgents, "false");
    expect(setSettingMock).toHaveBeenCalledWith(POLICY_KEYS.memberAutomations, "true");
  });
});

describe("isPolicyKey", () => {
  it("recognises every policy key and nothing else", () => {
    expect(isPolicyKey(POLICY_KEYS.memberPersonalAgents)).toBe(true);
    expect(isPolicyKey(POLICY_KEYS.memberAutomations)).toBe(true);
    expect(isPolicyKey("policy.anything_new")).toBe(true);
    expect(isPolicyKey("org.timezone")).toBe(false);
  });
});

describe("isPausedPersonalAgent", () => {
  const personal = { isPersonal: true };
  const shared = { isPersonal: false };
  const off = { memberPersonalAgents: false, memberAutomations: true };

  it("pauses a member's personal agent when personal agents are off", () => {
    expect(isPausedPersonalAgent(personal, "member", off)).toBe(true);
  });

  it("never pauses an admin's personal agent", () => {
    expect(isPausedPersonalAgent(personal, "admin", off)).toBe(false);
  });

  it("treats an owner with no known role as a member, not as an admin", () => {
    expect(isPausedPersonalAgent(personal, null, off)).toBe(true);
    expect(isPausedPersonalAgent(personal, undefined, off)).toBe(true);
  });

  it("never pauses a shared agent", () => {
    expect(isPausedPersonalAgent(shared, "member", off)).toBe(false);
  });

  it("pauses nothing while personal agents are on", () => {
    expect(isPausedPersonalAgent(personal, "member", ON)).toBe(false);
  });
});

describe("arePersonalAutomationsPaused", () => {
  const personal = { isPersonal: true };

  it("pauses a member's personal-agent automations when member automations are off", () => {
    expect(
      arePersonalAutomationsPaused(personal, "member", {
        memberPersonalAgents: true,
        memberAutomations: false,
      })
    ).toBe(true);
  });

  it("pauses them too when personal agents are off — an automation runs as its agent", () => {
    expect(
      arePersonalAutomationsPaused(personal, "member", {
        memberPersonalAgents: false,
        memberAutomations: true,
      })
    ).toBe(true);
  });

  it("never pauses an admin's automations or a shared agent's", () => {
    const allOff = { memberPersonalAgents: false, memberAutomations: false };
    expect(arePersonalAutomationsPaused(personal, "admin", allOff)).toBe(false);
    expect(arePersonalAutomationsPaused({ isPersonal: false }, "member", allOff)).toBe(false);
  });

  it("pauses nothing while both switches are on", () => {
    expect(arePersonalAutomationsPaused(personal, "member", ON)).toBe(false);
  });
});

describe("arePersonalAutomationsPausedFor", () => {
  beforeEach(() => getSettingsByKeysMock.mockReset());

  it("reads the policy for a member's personal agent", async () => {
    getSettingsByKeysMock.mockResolvedValue(new Map([[POLICY_KEYS.memberAutomations, "false"]]));
    await expect(arePersonalAutomationsPausedFor({ isPersonal: true }, "member")).resolves.toBe(
      true
    );
  });

  it("answers a shared agent or an admin without reading anything", async () => {
    await expect(arePersonalAutomationsPausedFor({ isPersonal: false }, "member")).resolves.toBe(
      false
    );
    await expect(arePersonalAutomationsPausedFor({ isPersonal: true }, "admin")).resolves.toBe(
      false
    );
    expect(getSettingsByKeysMock).not.toHaveBeenCalled();
  });
});
