import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildGitHubIssueUrl,
  buildBugReportUrl,
  buildIssueBody,
  fetchDiagnostics,
} from "@/lib/github-issue";

describe("buildGitHubIssueUrl", () => {
  it("should return a GitHub new-issue URL", () => {
    const url = buildGitHubIssueUrl({
      error: "Connection refused",
      page: "/setup",
    });
    expect(url).toMatch(/^https:\/\/github\.com\/heypinchy\/pinchy\/issues\/new\?/);
  });

  it("should include the error in the title", () => {
    const url = buildGitHubIssueUrl({
      error: "Connection refused",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("title")).toContain("Connection refused");
    expect(params.get("title")).toMatch(/^Error:/);
  });

  it("should truncate long error messages in the title", () => {
    const longError = "A".repeat(100);
    const url = buildGitHubIssueUrl({
      error: longError,
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const title = params.get("title")!;
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("should include a paste hint in the body", () => {
    const url = buildGitHubIssueUrl({
      error: "Connection refused",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toMatch(/paste/i);
    expect(body).toMatch(/clipboard/i);
  });

  it("should not include full diagnostics in the URL body", () => {
    const url = buildGitHubIssueUrl({
      error: "Setup failed",
      page: "/setup",
      diagnostics: {
        database: "connected",
        openclaw: "unreachable",
        version: "0.1.0",
        nodeEnv: "production",
      },
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).not.toContain("Database: connected");
  });

  it("should handle special characters in error messages", () => {
    const url = buildGitHubIssueUrl({
      error: "Failed: key=abc&status=error#hash",
      page: "/setup",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toContain("key=abc&status=error#hash");
  });
});

describe("buildBugReportUrl", () => {
  it("should return a GitHub new-issue URL", () => {
    const url = buildBugReportUrl("/chat/abc");
    expect(url).toMatch(/^https:\/\/github\.com\/heypinchy\/pinchy\/issues\/new\?/);
  });

  it("should include environment info in the body", () => {
    const url = buildBugReportUrl("/settings");
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("Pinchy:");
    expect(body).toContain("Browser:");
    expect(body).toContain("/settings");
  });

  it("should include steps to reproduce with hint", () => {
    const url = buildBugReportUrl("/chat/abc");
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("Steps to reproduce");
    expect(body).toMatch(/please describe/i);
  });

  it("should include a bug report label", () => {
    const url = buildBugReportUrl("/chat/abc");
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("labels")).toBe("bug");
  });
});

describe("buildIssueBody", () => {
  it("should include the error message", () => {
    const body = buildIssueBody({
      error: "Connection refused",
      page: "/setup",
    });
    expect(body).toContain("Connection refused");
  });

  it("should include environment info", () => {
    const body = buildIssueBody({
      error: "Connection refused",
      page: "/setup",
    });
    expect(body).toContain("Browser:");
    expect(body).toContain("Pinchy:");
  });

  it("should include the page path", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup/provider",
    });
    expect(body).toContain("/setup/provider");
  });

  it("should include status code when provided", () => {
    const body = buildIssueBody({
      error: "Internal server error",
      statusCode: 500,
      page: "/setup",
    });
    expect(body).toContain("500");
  });

  it("should include diagnostics when provided", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup",
      diagnostics: {
        database: "connected",
        openclaw: "unreachable",
        version: "0.1.0",
        nodeEnv: "production",
      },
    });
    expect(body).toContain("Database: connected");
    expect(body).toContain("OpenClaw: unreachable");
    expect(body).toContain("0.1.0");
  });

  it("should omit diagnostics section when not provided", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup",
    });
    expect(body).not.toContain("Server Diagnostics");
  });

  it("should include captured logs when provided via diagnostics", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup",
      diagnostics: {
        database: "unreachable",
        openclaw: "connected",
        version: "0.1.0",
        nodeEnv: "production",
        logs: "2026-03-04T08:00:00Z [ERROR] DB connection refused\n2026-03-04T08:00:01Z [WARN] Retrying...",
      },
    });
    expect(body).toContain("DB connection refused");
    expect(body).toContain("Retrying...");
  });

  it("should show manual logs instruction when no logs available", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup",
    });
    expect(body).toContain("docker compose logs pinchy");
  });

  it("should handle special characters in error messages", () => {
    const body = buildIssueBody({
      error: "Failed: key=abc&status=error#hash",
      page: "/setup",
    });
    expect(body).toContain("key=abc&status=error#hash");
  });

  it("should include a hint in the steps to reproduce section", () => {
    const body = buildIssueBody({
      error: "Setup failed",
      page: "/setup",
    });
    expect(body).toContain("Steps to reproduce");
    expect(body).toMatch(/please describe/i);
  });
});

describe("fetchDiagnostics", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should return diagnostics on successful fetch", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        database: "connected",
        openclaw: "connected",
        version: "0.1.0",
        nodeEnv: "production",
        logs: "[ERROR] something happened",
      }),
    } as Response);

    const result = await fetchDiagnostics();

    expect(result).toEqual({
      database: "connected",
      openclaw: "connected",
      version: "0.1.0",
      nodeEnv: "production",
      logs: "[ERROR] something happened",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/diagnostics",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("should return null when fetch fails", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchDiagnostics();

    expect(result).toBeNull();
  });

  it("should return null when response is not ok", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    const result = await fetchDiagnostics();

    expect(result).toBeNull();
  });
});
