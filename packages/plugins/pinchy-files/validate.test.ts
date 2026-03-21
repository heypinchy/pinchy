import { describe, it, expect } from "vitest";
import { validateAccess, MAX_FILE_SIZE, MAX_PDF_FILE_SIZE } from "./validate";

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

describe("MAX_FILE_SIZE exports", () => {
  it("exports MAX_FILE_SIZE as 10MB for text files", () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
  });

  it("exports MAX_PDF_FILE_SIZE as 50MB for PDF files", () => {
    expect(MAX_PDF_FILE_SIZE).toBe(50 * 1024 * 1024);
  });
});
