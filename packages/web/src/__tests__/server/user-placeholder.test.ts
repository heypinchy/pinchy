import { describe, it, expect } from "vitest";

import { resolveUserPlaceholder } from "@/server/user-placeholder";

describe("resolveUserPlaceholder", () => {
  describe("with a known user name", () => {
    it("substitutes a single {user}", () => {
      expect(resolveUserPlaceholder("Hi {user}!", "Ada")).toBe("Hi Ada!");
    });

    it("substitutes every occurrence", () => {
      expect(resolveUserPlaceholder("{user}, hello {user}", "Ada")).toBe("Ada, hello Ada");
    });

    it("leaves text without the placeholder untouched", () => {
      expect(resolveUserPlaceholder("Hello there", "Ada")).toBe("Hello there");
    });
  });

  describe("without a user name", () => {
    it.each([null, undefined, ""])("strips a leading ', {user}' run (name=%p)", (name) => {
      expect(resolveUserPlaceholder("Hi, {user}!", name)).toBe("Hi!");
    });

    it("strips a bare {user} with a trailing comma and space", () => {
      expect(resolveUserPlaceholder("{user}, welcome", null)).toBe("welcome");
    });

    it("strips a bare {user} with a trailing period", () => {
      expect(resolveUserPlaceholder("Welcome {user}.", null)).toBe("Welcome ");
    });

    it("strips a trailing {user} with no punctuation", () => {
      expect(resolveUserPlaceholder("Welcome {user}", null)).toBe("Welcome ");
    });

    it("leaves text without the placeholder untouched", () => {
      expect(resolveUserPlaceholder("Hello there", null)).toBe("Hello there");
    });
  });
});
