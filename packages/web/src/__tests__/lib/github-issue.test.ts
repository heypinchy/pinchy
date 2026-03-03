import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl } from "@/lib/github-issue";

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
    expect(params.get("title")).toMatch(/^Setup error:/);
  });

  it("should include environment info in the body", () => {
    const url = buildGitHubIssueUrl({
      error: "Connection refused",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("Browser:");
    expect(body).toContain("Pinchy:");
  });

  it("should include the error in the body", () => {
    const url = buildGitHubIssueUrl({
      error: "Connection refused",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("Connection refused");
  });

  it("should include the page path in the body", () => {
    const url = buildGitHubIssueUrl({
      error: "Setup failed",
      page: "/setup/provider",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("/setup/provider");
  });

  it("should include status code when provided", () => {
    const url = buildGitHubIssueUrl({
      error: "Internal server error",
      statusCode: 500,
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("500");
  });

  it("should include diagnostics when provided", () => {
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
    expect(body).toContain("Database: connected");
    expect(body).toContain("OpenClaw: unreachable");
    expect(body).toContain("0.1.0");
  });

  it("should omit diagnostics section when not provided", () => {
    const url = buildGitHubIssueUrl({
      error: "Setup failed",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).not.toContain("Server Diagnostics");
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

  it("should handle special characters in error messages", () => {
    const url = buildGitHubIssueUrl({
      error: "Failed: key=abc&status=error#hash",
      page: "/setup",
    });
    const parsed = new URL(url);
    const body = parsed.searchParams.get("body")!;
    expect(body).toContain("key=abc&status=error#hash");
  });

  it("should include docker logs instruction in body", () => {
    const url = buildGitHubIssueUrl({
      error: "Setup failed",
      page: "/setup",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    const body = params.get("body")!;
    expect(body).toContain("docker compose logs pinchy");
  });
});
