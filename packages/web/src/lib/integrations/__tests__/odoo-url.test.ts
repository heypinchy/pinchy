import { describe, it, expect } from "vitest";
import { parseOdooSubdomainHint, generateConnectionName } from "../odoo-url";

describe("parseOdooSubdomainHint", () => {
  it("extracts subdomain from *.odoo.com", () => {
    expect(parseOdooSubdomainHint("https://mycompany.odoo.com")).toBe("mycompany");
  });

  it("extracts subdomain from *.dev.odoo.com", () => {
    expect(
      parseOdooSubdomainHint("https://traun-capital-staging-pinchy-30159487.dev.odoo.com")
    ).toBe("traun-capital-staging-pinchy-30159487");
  });

  it("returns null for non-odoo.com domains", () => {
    expect(parseOdooSubdomainHint("https://odoo.myserver.com")).toBeNull();
  });

  it("returns null for bare odoo.com", () => {
    expect(parseOdooSubdomainHint("https://odoo.com")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseOdooSubdomainHint("not-a-url")).toBeNull();
  });

  it("handles URLs with paths", () => {
    expect(parseOdooSubdomainHint("https://mycompany.odoo.com/web/login")).toBe("mycompany");
  });
});

describe("generateConnectionName", () => {
  it("capitalizes subdomain from odoo.com", () => {
    expect(generateConnectionName("https://mycompany.odoo.com")).toBe("Mycompany Odoo");
  });

  it("title-cases hyphenated subdomain from dev.odoo.com", () => {
    expect(
      generateConnectionName("https://traun-capital-staging-pinchy-30159487.dev.odoo.com")
    ).toBe("Traun Capital Staging Pinchy 30159487 Odoo");
  });

  it("uses hostname for self-hosted", () => {
    expect(generateConnectionName("https://odoo.gittermattenzaun.at")).toBe(
      "Gittermattenzaun Odoo"
    );
  });

  it("uses hostname for erp subdomain", () => {
    expect(generateConnectionName("https://erp.mueller.com")).toBe("Mueller Odoo");
  });

  it("handles localhost", () => {
    expect(generateConnectionName("http://localhost:8069")).toBe("Localhost Odoo");
  });

  it("handles IP address", () => {
    expect(generateConnectionName("http://192.168.1.100:8069")).toBe("192.168.1.100 Odoo");
  });

  it("returns fallback for invalid URL", () => {
    expect(generateConnectionName("not-a-url")).toBe("Odoo");
  });
});
