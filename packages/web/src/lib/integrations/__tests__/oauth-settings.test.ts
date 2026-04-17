import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { getSetting, setSetting } from "@/lib/settings";
import {
  getOAuthSettings,
  saveOAuthSettings,
  GOOGLE_OAUTH_SETTINGS_KEY,
} from "../oauth-settings.js";

describe("oauth-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GOOGLE_OAUTH_SETTINGS_KEY", () => {
    it("equals 'google_oauth_credentials'", () => {
      expect(GOOGLE_OAUTH_SETTINGS_KEY).toBe("google_oauth_credentials");
    });
  });

  describe("getOAuthSettings", () => {
    it("returns null when no settings are stored", async () => {
      vi.mocked(getSetting).mockResolvedValue(null);

      const result = await getOAuthSettings("google");
      expect(result).toBeNull();
      expect(getSetting).toHaveBeenCalledWith("google_oauth_credentials");
    });

    it("returns parsed clientId and clientSecret when settings exist", async () => {
      vi.mocked(getSetting).mockResolvedValue(
        JSON.stringify({
          clientId: "my-client-id",
          clientSecret: "my-client-secret",
        })
      );

      const result = await getOAuthSettings("google");
      expect(result).toEqual({
        clientId: "my-client-id",
        clientSecret: "my-client-secret",
      });
      expect(getSetting).toHaveBeenCalledWith("google_oauth_credentials");
    });

    it("returns null when stored value is invalid JSON", async () => {
      vi.mocked(getSetting).mockResolvedValue("not-valid-json");

      const result = await getOAuthSettings("google");
      expect(result).toBeNull();
    });

    it("returns null when stored value is missing clientId", async () => {
      vi.mocked(getSetting).mockResolvedValue(JSON.stringify({ clientSecret: "secret-only" }));

      const result = await getOAuthSettings("google");
      expect(result).toBeNull();
    });

    it("returns null when stored value is missing clientSecret", async () => {
      vi.mocked(getSetting).mockResolvedValue(JSON.stringify({ clientId: "id-only" }));

      const result = await getOAuthSettings("google");
      expect(result).toBeNull();
    });
  });

  describe("saveOAuthSettings", () => {
    it("stores settings as encrypted JSON via setSetting", async () => {
      vi.mocked(setSetting).mockResolvedValue(undefined);

      await saveOAuthSettings("google", {
        clientId: "new-client-id",
        clientSecret: "new-client-secret",
      });

      expect(setSetting).toHaveBeenCalledWith(
        "google_oauth_credentials",
        JSON.stringify({
          clientId: "new-client-id",
          clientSecret: "new-client-secret",
        }),
        true
      );
    });

    it("overwrites existing settings on repeated save", async () => {
      vi.mocked(setSetting).mockResolvedValue(undefined);

      await saveOAuthSettings("google", {
        clientId: "first-id",
        clientSecret: "first-secret",
      });

      await saveOAuthSettings("google", {
        clientId: "second-id",
        clientSecret: "second-secret",
      });

      expect(setSetting).toHaveBeenCalledTimes(2);
      expect(setSetting).toHaveBeenLastCalledWith(
        "google_oauth_credentials",
        JSON.stringify({
          clientId: "second-id",
          clientSecret: "second-secret",
        }),
        true
      );
    });
  });
});
