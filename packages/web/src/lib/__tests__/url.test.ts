import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../url";

describe("normalizeUrl", () => {
  describe("path / query / fragment stripping", () => {
    it("strips trailing slash", () => {
      expect(normalizeUrl("https://odoo.example.com/")).toBe("https://odoo.example.com");
    });

    it("strips path", () => {
      expect(normalizeUrl("https://odoo.example.com/odoo")).toBe("https://odoo.example.com");
    });

    it("strips /web/login path", () => {
      expect(normalizeUrl("https://odoo.example.com/web/login")).toBe("https://odoo.example.com");
    });

    it("strips query string", () => {
      expect(normalizeUrl("https://odoo.example.com/web?db=prod")).toBe("https://odoo.example.com");
    });

    it("strips fragment", () => {
      expect(normalizeUrl("https://odoo.example.com/web#section")).toBe("https://odoo.example.com");
    });

    it("returns origin as-is when already clean", () => {
      expect(normalizeUrl("https://odoo.example.com")).toBe("https://odoo.example.com");
    });

    it("preserves port", () => {
      expect(normalizeUrl("https://odoo.example.com:8069/web")).toBe(
        "https://odoo.example.com:8069"
      );
    });
  });

  describe("protocol prepending", () => {
    it("prepends https:// when no protocol given", () => {
      expect(normalizeUrl("odoo-demo.heypinchy.com")).toBe("https://odoo-demo.heypinchy.com");
    });

    it("prepends https:// and strips path simultaneously", () => {
      expect(normalizeUrl("odoo-demo.heypinchy.com/web/login")).toBe(
        "https://odoo-demo.heypinchy.com"
      );
    });

    it("keeps http:// when explicitly given", () => {
      expect(normalizeUrl("http://localhost:8069/")).toBe("http://localhost:8069");
    });

    it("keeps https:// when explicitly given", () => {
      expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    });

    it("handles uppercase HTTPS:// (case-insensitive)", () => {
      expect(normalizeUrl("HTTPS://example.com/path")).toBe("https://example.com");
    });

    it("trims surrounding whitespace before normalizing", () => {
      expect(normalizeUrl("  odoo-demo.heypinchy.com  ")).toBe("https://odoo-demo.heypinchy.com");
    });
  });

  describe("invalid input", () => {
    it("returns null for empty string", () => {
      expect(normalizeUrl("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(normalizeUrl("   ")).toBeNull();
    });

    it("returns null for non-URL-shaped input that even prepending cannot fix", () => {
      expect(normalizeUrl("not a url at all with spaces")).toBeNull();
    });
  });
});
