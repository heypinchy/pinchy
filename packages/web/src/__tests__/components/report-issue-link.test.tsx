import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ReportIssueLink } from "@/components/report-issue-link";

const mockBuildGitHubIssueUrl = vi
  .fn()
  .mockReturnValue("https://github.com/heypinchy/pinchy/issues/new?title=test");
const mockFetchDiagnostics = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/github-issue", () => ({
  buildGitHubIssueUrl: (...args: unknown[]) => mockBuildGitHubIssueUrl(...args),
  fetchDiagnostics: () => mockFetchDiagnostics(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/setup",
}));

describe("ReportIssueLink", () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
  });

  it("should render the report link text", () => {
    render(<ReportIssueLink error="Test error" />);
    expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
  });

  it("should fetch diagnostics and open GitHub URL on click", async () => {
    const user = userEvent.setup();
    const diagnostics = {
      database: "connected" as const,
      openclaw: "connected" as const,
      version: "0.1.0",
      nodeEnv: "production",
    };
    mockFetchDiagnostics.mockResolvedValueOnce(diagnostics);

    render(<ReportIssueLink error="Connection refused" statusCode={500} />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    await waitFor(() => {
      expect(mockFetchDiagnostics).toHaveBeenCalled();
      expect(mockBuildGitHubIssueUrl).toHaveBeenCalledWith({
        error: "Connection refused",
        statusCode: 500,
        page: "/setup",
        diagnostics,
      });
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://github.com/heypinchy/pinchy/issues/new?title=test",
        "_blank",
        "noopener,noreferrer"
      );
    });
  });

  it("should open GitHub URL without diagnostics when fetch fails", async () => {
    const user = userEvent.setup();
    mockFetchDiagnostics.mockRejectedValueOnce(new Error("Network error"));

    render(<ReportIssueLink error="Setup failed" />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    await waitFor(() => {
      expect(mockBuildGitHubIssueUrl).toHaveBeenCalledWith(
        expect.objectContaining({ diagnostics: undefined })
      );
      expect(windowOpenSpy).toHaveBeenCalled();
    });
  });

  it("should show loading state while fetching diagnostics", async () => {
    const user = userEvent.setup();
    mockFetchDiagnostics.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 500))
    );

    render(<ReportIssueLink error="Test error" />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    expect(screen.getByRole("button", { name: /report this issue/i })).toBeDisabled();
  });
});
