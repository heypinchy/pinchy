import { describe, it, expect } from "vitest";
import { getLanguageOptions, getCountryOptions } from "@/lib/locale-options";

describe("locale-options", () => {
  describe("getLanguageOptions", () => {
    it("returns more than 100 languages", () => {
      expect(getLanguageOptions().length).toBeGreaterThan(100);
    });

    it("returns ISO 639-1 codes as values", () => {
      const options = getLanguageOptions();
      expect(options.find((o) => o.value === "en")?.label).toBe("English");
      expect(options.find((o) => o.value === "de")?.label).toBe("German");
      expect(options.find((o) => o.value === "ja")?.label).toBe("Japanese");
    });

    it("returns entries sorted alphabetically by label", () => {
      const labels = getLanguageOptions().map((o) => o.label);
      const sorted = [...labels].sort((a, b) => a.localeCompare(b));
      expect(labels).toEqual(sorted);
    });
  });

  describe("getCountryOptions", () => {
    it("returns more than 200 countries", () => {
      expect(getCountryOptions().length).toBeGreaterThan(200);
    });

    it("returns ISO 3166-1 alpha-2 codes as values", () => {
      const options = getCountryOptions();
      expect(options.find((o) => o.value === "AT")?.label).toMatch(/austria/i);
      expect(options.find((o) => o.value === "DE")?.label).toMatch(/germany/i);
      expect(options.find((o) => o.value === "US")?.label).toMatch(/united states/i);
    });

    it("returns entries sorted alphabetically by label", () => {
      const labels = getCountryOptions().map((o) => o.label);
      const sorted = [...labels].sort((a, b) => a.localeCompare(b));
      expect(labels).toEqual(sorted);
    });
  });
});
