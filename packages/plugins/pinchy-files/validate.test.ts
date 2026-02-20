import { describe, it, expect } from "vitest";
import { validateAccess } from "./validate";

const agentConfig = {
  allowed_paths: ["/data/hr-docs/", "/data/policies/"],
};

describe("validateAccess", () => {
  it("should allow paths within allowed directories", () => {
    expect(() =>
      validateAccess(agentConfig, "/data/hr-docs/vacation.md")
    ).not.toThrow();
  });

  it("should reject paths outside allowed directories", () => {
    expect(() =>
      validateAccess(agentConfig, "/data/finance/report.md")
    ).toThrow("Access denied");
  });

  it("should reject paths with null bytes", () => {
    expect(() =>
      validateAccess(agentConfig, "/data/hr-docs/\0evil")
    ).toThrow("Invalid path");
  });

  it("should reject dotfiles", () => {
    expect(() => validateAccess(agentConfig, "/data/hr-docs/.env")).toThrow(
      "Hidden files"
    );
  });

  it("should reject paths not under /data/", () => {
    expect(() => validateAccess(agentConfig, "/etc/passwd")).toThrow(
      "Access denied"
    );
  });

  it("should reject traversal attempts", () => {
    expect(() =>
      validateAccess(agentConfig, "/data/hr-docs/../../etc/passwd")
    ).toThrow("Access denied");
  });
});
