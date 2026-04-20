import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));

import * as settings from "@/lib/settings";
import {
  getOpenAiSubscription,
  setOpenAiSubscription,
  deleteOpenAiSubscription,
  SUBSCRIPTION_KEY,
} from "@/lib/openai-subscription";

describe("openai-subscription storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no setting is stored", async () => {
    (settings.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await getOpenAiSubscription()).toBeNull();
  });

  it("parses the stored JSON blob", async () => {
    const blob = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-04-20T15:00:00Z",
      accountId: "acc",
      accountEmail: "u@e.com",
      connectedAt: "2026-04-20T09:00:00Z",
      refreshFailureCount: 0,
    };
    (settings.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(blob));
    expect(await getOpenAiSubscription()).toEqual(blob);
  });

  it("persists the blob encrypted", async () => {
    const blob = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-04-20T15:00:00Z",
      accountId: "acc",
      accountEmail: "u@e.com",
      connectedAt: "2026-04-20T09:00:00Z",
      refreshFailureCount: 0,
    };
    await setOpenAiSubscription(blob);
    expect(settings.setSetting).toHaveBeenCalledWith(SUBSCRIPTION_KEY, JSON.stringify(blob), true);
  });

  it("deletes the setting", async () => {
    await deleteOpenAiSubscription();
    expect(settings.deleteSetting).toHaveBeenCalledWith(SUBSCRIPTION_KEY);
  });
});
