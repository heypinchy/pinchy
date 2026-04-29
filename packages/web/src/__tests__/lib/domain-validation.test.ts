import { describe, it, expect } from "vitest";
import { isValidDomain, validatePinchyWebConfig } from "@/lib/domain-validation";

describe("isValidDomain", () => {
  it.each(["example.com", "docs.example.com", "a.b.c.d.example.com", "xn--bcher-kva.example"])(
    "accepts %s",
    (d) => {
      expect(isValidDomain(d)).toBe(true);
    }
  );

  it.each([
    "",
    "localhost",
    "not a domain",
    "example..com",
    "-example.com",
    "example-.com",
    "example.com ",
    " example.com",
  ])("rejects %s", (d) => {
    expect(isValidDomain(d)).toBe(false);
  });
});

describe("validatePinchyWebConfig", () => {
  it("returns null when pluginConfig is absent", () => {
    expect(validatePinchyWebConfig(undefined)).toBeNull();
    expect(validatePinchyWebConfig(null)).toBeNull();
  });

  it("returns null when pinchy-web entry is absent", () => {
    expect(validatePinchyWebConfig({ "pinchy-files": { allowed_paths: [] } })).toBeNull();
  });

  it("returns null for valid allowedDomains / excludedDomains", () => {
    expect(
      validatePinchyWebConfig({
        "pinchy-web": {
          allowedDomains: ["example.com", "docs.example.com"],
          excludedDomains: ["bad.com"],
        },
      })
    ).toBeNull();
  });

  it("rejects non-object pluginConfig", () => {
    expect(validatePinchyWebConfig("string")).toMatch(/object/i);
    expect(validatePinchyWebConfig([])).toMatch(/object/i);
  });

  it("rejects invalid allowedDomains entry", () => {
    expect(
      validatePinchyWebConfig({ "pinchy-web": { allowedDomains: ["not a domain!"] } })
    ).toMatch(/allowedDomains/i);
  });

  it("rejects invalid excludedDomains entry", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { excludedDomains: ["@@@"] } })).toMatch(
      /excludedDomains/i
    );
  });

  it("rejects non-array allowedDomains", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { allowedDomains: "example.com" } })).toMatch(
      /allowedDomains/i
    );
  });

  it("rejects non-string domain entries", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { allowedDomains: [123] } })).toMatch(
      /allowedDomains/i
    );
  });

  it("rejects non-object pinchy-web entry", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": "yes" })).toMatch(/pinchy-web/i);
  });
});
