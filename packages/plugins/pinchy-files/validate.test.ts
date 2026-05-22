import { describe, it, expect } from "vitest";
import { validateAccess, MAX_FILE_SIZE, MAX_PDF_FILE_SIZE, ALLOWED_ROOTS } from "./validate";

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

  it("rejects write when path is in write_paths but not in allowed_paths (defense in depth)", () => {
    // Defense against tampered or buggy config that has write_paths NOT being
    // a subset of allowed_paths. Build-time validator enforces the subset
    // invariant, but the runtime must not trust the config layout blindly.
    expect(() =>
      validateAccess(
        {
          allowed_paths: ["/data/kb"],
          write_paths: ["/data/other"], // not in allowed_paths
        },
        "/data/other/x.csv",
        "write"
      )
    ).toThrow(/allowed_paths|subset/i);
  });

  it("ALLOWED_ROOTS contains both /data/ and workspace prefix", () => {
    expect(ALLOWED_ROOTS).toContain("/data/");
    expect(ALLOWED_ROOTS).toContain("/root/.openclaw/workspaces/");
  });
});

describe("write-mode rejection lists allowed write paths (LLM hint)", () => {
  // When pinchy_write rejects a path, the LLM has no way to know which
  // paths it CAN write to unless the error message tells it. Without
  // this hint, the LLM tends to retry the same wrong path or give up.
  // See #418.
  it("includes the configured write_paths in the rejection message", () => {
    try {
      validateAccess(
        {
          allowed_paths: [
            "/root/.openclaw/workspaces/a/uploads",
            "/root/.openclaw/workspaces/a/workbench",
          ],
          write_paths: [
            "/root/.openclaw/workspaces/a/uploads",
            "/root/.openclaw/workspaces/a/workbench",
          ],
        },
        "/root/.openclaw/workspaces/a/test.txt",
        "write"
      );
      throw new Error("expected validateAccess to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("not in write_paths");
      expect(message).toContain("/root/.openclaw/workspaces/a/uploads");
      expect(message).toContain("/root/.openclaw/workspaces/a/workbench");
    }
  });

  it("read-mode rejection still mentions allowed directories", () => {
    try {
      validateAccess(
        { allowed_paths: ["/data/kb/"] },
        "/data/other/x.csv",
        "read"
      );
      throw new Error("expected validateAccess to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("not in allowed directories");
      expect(message).toContain("/data/kb/");
    }
  });

  it("does not include write_paths when none are configured", () => {
    // No write_paths configured → don't dangle an empty list in the error.
    try {
      validateAccess(
        { allowed_paths: ["/data/kb/"], write_paths: [] },
        "/data/kb/x.csv",
        "write"
      );
      throw new Error("expected validateAccess to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("not in write_paths");
      // Empty list — error should not show a trailing colon with nothing after.
      expect(message).not.toMatch(/:\s*$/);
    }
  });
});

describe("path-boundary matching (sibling-directory escape)", () => {
  // Allow-list entries without trailing slashes (`/foo/uploads`) used to
  // match any sibling whose name shared the prefix (`/foo/uploadsevil`)
  // because the check was a raw `String.startsWith` with no path-boundary
  // requirement. The matcher must treat allow-list entries as directory
  // boundaries: only the dir itself or a child of it counts as a match.
  // Discovered while reviewing #418; pre-existing in the codebase.
  it("rejects a sibling directory whose name shares a prefix with an allowed read path", () => {
    expect(() =>
      validateAccess(
        { allowed_paths: ["/root/.openclaw/workspaces/a/uploads"] },
        "/root/.openclaw/workspaces/a/uploadsevil/leak.txt",
        "read"
      )
    ).toThrow(/not in allowed/i);
  });

  it("rejects a sibling directory whose name shares a prefix with a write_paths entry", () => {
    expect(() =>
      validateAccess(
        {
          allowed_paths: [
            "/root/.openclaw/workspaces/a/workbench",
            // Include the sibling in allowed_paths so the subset-invariant
            // check isn't what catches it — we want this to fall over on
            // the write_paths check specifically.
            "/root/.openclaw/workspaces/a/workbenchevil",
          ],
          write_paths: ["/root/.openclaw/workspaces/a/workbench"],
        },
        "/root/.openclaw/workspaces/a/workbenchevil/leak.txt",
        "write"
      )
    ).toThrow(/not in write/i);
  });

  it("still allows reading a file inside an allow-listed directory (no over-correction)", () => {
    // The fix must not regress the common case.
    expect(() =>
      validateAccess(
        { allowed_paths: ["/root/.openclaw/workspaces/a/uploads"] },
        "/root/.openclaw/workspaces/a/uploads/file.txt",
        "read"
      )
    ).not.toThrow();
  });

  it("still allows allow-list entries that already end with a slash", () => {
    // Pre-existing entries (admin-configured KB paths) commonly end with /.
    expect(() =>
      validateAccess(
        { allowed_paths: ["/data/hr-docs/"] },
        "/data/hr-docs/vacation.md",
        "read"
      )
    ).not.toThrow();
  });
});
