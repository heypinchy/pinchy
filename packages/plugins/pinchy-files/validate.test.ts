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

import { ALLOWED_ROOTS } from "./validate";

describe("multi-root + mode validation", () => {
  it("accepts paths under /data/ root", () => {
    expect(() =>
      validateAccess({ allowed_paths: ["/data/kb"] }, "/data/kb/file.txt", "read")
    ).not.toThrow();
  });

  it("accepts paths under /root/.openclaw/workspaces/ root", () => {
    expect(() =>
      validateAccess(
        { allowed_paths: ["/root/.openclaw/workspaces/agent-1/uploads"] },
        "/root/.openclaw/workspaces/agent-1/uploads/file.txt",
        "read"
      )
    ).not.toThrow();
  });

  it("rejects paths outside both allowed roots", () => {
    expect(() =>
      validateAccess({ allowed_paths: ["/data/kb"] }, "/etc/passwd", "read")
    ).toThrow(/outside.*allowed root/i);
  });

  it("rejects write to read-only path when write_paths excludes it", () => {
    expect(() =>
      validateAccess(
        { allowed_paths: ["/data/kb"], write_paths: [] },
        "/data/kb/file.txt",
        "write"
      )
    ).toThrow(/not in.*write/i);
  });

  it("accepts write to path in write_paths", () => {
    expect(() =>
      validateAccess(
        {
          allowed_paths: ["/root/.openclaw/workspaces/agent-1/uploads"],
          write_paths: ["/root/.openclaw/workspaces/agent-1/uploads"],
        },
        "/root/.openclaw/workspaces/agent-1/uploads/out.csv",
        "write"
      )
    ).not.toThrow();
  });

  it("ALLOWED_ROOTS contains both /data/ and workspace prefix", () => {
    expect(ALLOWED_ROOTS).toContain("/data/");
    expect(ALLOWED_ROOTS).toContain("/root/.openclaw/workspaces/");
  });
});
