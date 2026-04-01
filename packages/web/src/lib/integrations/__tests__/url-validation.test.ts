import { describe, it, expect, afterEach, vi } from "vitest";
import { validateExternalUrl, isPrivateUrl } from "../url-validation";

describe("isPrivateUrl", () => {
  it("rejects localhost", () => {
    expect(isPrivateUrl("http://localhost:8069")).toBe(true);
  });

  it("rejects 127.0.0.1 (loopback)", () => {
    expect(isPrivateUrl("http://127.0.0.1:8069")).toBe(true);
  });

  it("rejects 10.x.x.x (class A private)", () => {
    expect(isPrivateUrl("http://10.0.0.1:8069")).toBe(true);
  });

  it("rejects 172.16.x.x (class B private)", () => {
    expect(isPrivateUrl("http://172.16.0.1:8069")).toBe(true);
  });

  it("rejects 172.31.x.x (class B private upper bound)", () => {
    expect(isPrivateUrl("http://172.31.255.255:8069")).toBe(true);
  });

  it("rejects 192.168.x.x (class C private)", () => {
    expect(isPrivateUrl("http://192.168.1.1:8069")).toBe(true);
  });

  it("rejects 169.254.x.x (link-local / AWS metadata)", () => {
    expect(isPrivateUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("rejects IPv6 loopback [::1]", () => {
    expect(isPrivateUrl("http://[::1]:8069")).toBe(true);
  });

  it("rejects IPv6 unique local address (fc00::/7)", () => {
    expect(isPrivateUrl("http://[fd12:3456:789a::1]:8069")).toBe(true);
  });

  it("rejects 0.0.0.0", () => {
    expect(isPrivateUrl("http://0.0.0.0:8069")).toBe(true);
  });

  it("accepts public domain", () => {
    expect(isPrivateUrl("https://odoo.example.com")).toBe(false);
  });

  it("accepts odoo.com subdomain", () => {
    expect(isPrivateUrl("https://mycompany.odoo.com")).toBe(false);
  });

  it("accepts public IP with HTTP", () => {
    expect(isPrivateUrl("http://203.0.113.50:8069")).toBe(false);
  });

  it("does not reject 172.32.x.x (outside private range)", () => {
    expect(isPrivateUrl("http://172.32.0.1:8069")).toBe(false);
  });
});

describe("validateExternalUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects non-HTTP scheme (ftp)", () => {
    const result = validateExternalUrl("ftp://odoo.example.com");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
  });

  it("rejects non-HTTP scheme (file)", () => {
    const result = validateExternalUrl("file:///etc/passwd");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
  });

  it("rejects invalid URL", () => {
    const result = validateExternalUrl("not-a-url");
    expect(result).toEqual({ valid: false, error: expect.any(String) });
  });

  it("rejects empty string", () => {
    const result = validateExternalUrl("");
    expect(result).toEqual({ valid: false, error: expect.any(String) });
  });

  it("rejects localhost", () => {
    const result = validateExternalUrl("http://localhost:8069");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("private") });
  });

  it("rejects 127.0.0.1", () => {
    const result = validateExternalUrl("http://127.0.0.1:8069");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("private") });
  });

  it("rejects AWS metadata endpoint", () => {
    const result = validateExternalUrl("http://169.254.169.254/latest/meta-data/");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("private") });
  });

  it("accepts HTTPS public domain", () => {
    const result = validateExternalUrl("https://odoo.example.com");
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("accepts HTTPS odoo.com subdomain", () => {
    const result = validateExternalUrl("https://mycompany.odoo.com");
    expect(result).toEqual({ valid: true, url: "https://mycompany.odoo.com" });
  });

  it("accepts HTTP for on-prem (public domain)", () => {
    const result = validateExternalUrl("http://odoo.example.com:8069");
    expect(result).toEqual({ valid: true, url: "http://odoo.example.com:8069" });
  });

  it("normalizes trailing slash", () => {
    const result = validateExternalUrl("https://odoo.example.com/");
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("strips path for origin-only output", () => {
    const result = validateExternalUrl("https://odoo.example.com/web/login");
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  describe("ALLOW_PRIVATE_URLS bypass", () => {
    it("allows private URLs when ALLOW_PRIVATE_URLS=1", () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = validateExternalUrl("http://localhost:8069");
      expect(result).toEqual({ valid: true, url: "http://localhost:8069" });
    });

    it("allows internal Docker hostnames when ALLOW_PRIVATE_URLS=1", () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = validateExternalUrl("http://odoo-mock:8069");
      expect(result).toEqual({ valid: true, url: "http://odoo-mock:8069" });
    });

    it("still rejects non-HTTP schemes even with ALLOW_PRIVATE_URLS=1", () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = validateExternalUrl("ftp://localhost:8069");
      expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
    });

    it("still rejects invalid URLs even with ALLOW_PRIVATE_URLS=1", () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = validateExternalUrl("not-a-url");
      expect(result).toEqual({ valid: false, error: expect.any(String) });
    });
  });
});
