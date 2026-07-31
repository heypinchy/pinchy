// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ReportIssueLink } from "@/components/report-issue-link";

const mockBuildGitHubIssueUrl = vi
  .fn()
  .mockReturnValue("https://github.com/heypinchy/pinchy/issues/new?title=test");
const mockBuildIssueBody = vi.fn().mockReturnValue("**Error:** Test error\n\n**Environment:**\n");
const mockFetchDiagnostics = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/github-issue", () => ({
  buildGitHubIssueUrl: (...args: unknown[]) => mockBuildGitHubIssueUrl(...args),
  buildIssueBody: (...args: unknown[]) => mockBuildIssueBody(...args),
  fetchDiagnostics: () => mockFetchDiagnostics(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/setup",
}));

describe("ReportIssueLink", () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  // No clipboard stub here on purpose. Every test that clicks calls
  // `userEvent.setup()` first, and `setup()` defines `navigator.clipboard`
  // itself (Clipboard.js: `attachClipboardStubToView`) with a `writeText` that
  // resolves — which is all the success path needs. Redefining the property on
  // top of that shadows the stub user-event will later look for, so its
  // per-test `resetClipboardStubOnView` silently does nothing and the mock
  // leaks into every later test in the file.
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

  it("should fetch diagnostics, build body and URL, and open GitHub on click", async () => {
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
      expect(mockBuildIssueBody).toHaveBeenCalledWith({
        error: "Connection refused",
        statusCode: 500,
        page: "/setup",
        diagnostics,
      });
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

  it("should show copied confirmation when clipboard write succeeds", async () => {
    const user = userEvent.setup();
    mockFetchDiagnostics.mockResolvedValueOnce(null);

    render(<ReportIssueLink error="Test error" />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    await waitFor(() => {
      expect(screen.getByText(/copied/i)).toBeInTheDocument();
    });
  });

  it("should open GitHub URL without diagnostics when fetch fails", async () => {
    const user = userEvent.setup();
    mockFetchDiagnostics.mockRejectedValueOnce(new Error("Network error"));

    render(<ReportIssueLink error="Setup failed" />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    await waitFor(() => {
      expect(mockBuildIssueBody).toHaveBeenCalledWith(
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

  it("should reset copied state after timeout and show the report button again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetchDiagnostics.mockResolvedValueOnce(null);

    render(<ReportIssueLink error="Test error" />);
    await user.click(screen.getByRole("button", { name: /report this issue/i }));

    await waitFor(() => {
      expect(screen.getByText(/copied/i)).toBeInTheDocument();
    });

    await vi.advanceTimersByTimeAsync(5000);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it("should still open GitHub URL when clipboard write fails", async () => {
    const user = userEvent.setup();
    mockFetchDiagnostics.mockResolvedValueOnce(null);
    // Spy on user-event's own stub rather than redefining the property (see the
    // note on beforeEach above): a rejecting `writeText` is exactly the denial
    // this test needs, and the descriptor user-event tracks stays intact.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Clipboard denied"));

    try {
      render(<ReportIssueLink error="Test error" />);
      await user.click(screen.getByRole("button", { name: /report this issue/i }));

      await waitFor(() => {
        expect(windowOpenSpy).toHaveBeenCalled();
      });
      // The write really was attempted and really did reject — otherwise this
      // would pass just as well against a clipboard that was never touched.
      expect(writeText).toHaveBeenCalled();
      expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
    } finally {
      // In a `finally` so a failing assertion above still restores the spy —
      // otherwise one red test leaves a rejecting clipboard in place.
      writeText.mockRestore();
    }
  });
});
