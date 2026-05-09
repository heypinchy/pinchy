import { describe, it, expect, beforeEach, vi } from "vitest";
import { getOrgTimezone, setOrgTimezone } from "@/lib/settings-timezone";
import * as settings from "@/lib/settings";

vi.mock("@/lib/settings");

describe("org timezone", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns stored timezone when set", async () => {
    vi.mocked(settings.getSetting).mockResolvedValue("Europe/Vienna");
    expect(await getOrgTimezone()).toBe("Europe/Vienna");
    expect(settings.getSetting).toHaveBeenCalledWith("org.timezone");
  });

  it("returns 'UTC' as default when nothing set", async () => {
    vi.mocked(settings.getSetting).mockResolvedValue(null);
    expect(await getOrgTimezone()).toBe("UTC");
  });

  it("rejects invalid IANA timezones", async () => {
    await expect(setOrgTimezone("NotATimezone")).rejects.toThrow(/invalid/i);
  });

  it("persists valid IANA timezone", async () => {
    await setOrgTimezone("Europe/Vienna");
    expect(settings.setSetting).toHaveBeenCalledWith("org.timezone", "Europe/Vienna");
  });
});
