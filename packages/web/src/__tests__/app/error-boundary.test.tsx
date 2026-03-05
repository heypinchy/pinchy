import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ErrorPage from "@/app/error";

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

describe("error.tsx (Error Boundary)", () => {
  const mockReset = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render an error heading", () => {
    const error = new Error("DB connection failed");
    render(<ErrorPage error={error} reset={mockReset} />);

    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
  });

  it("should display the error message", () => {
    const error = new Error("DB connection failed");
    render(<ErrorPage error={error} reset={mockReset} />);

    expect(screen.getByText(/DB connection failed/)).toBeInTheDocument();
  });

  it("should render the report issue link", () => {
    const error = new Error("DB connection failed");
    render(<ErrorPage error={error} reset={mockReset} />);

    expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
  });

  it("should render a try again button that calls reset", async () => {
    const user = userEvent.setup();
    const error = new Error("DB connection failed");
    render(<ErrorPage error={error} reset={mockReset} />);

    const tryAgainButton = screen.getByRole("button", { name: /try again/i });
    expect(tryAgainButton).toBeInTheDocument();

    await user.click(tryAgainButton);
    expect(mockReset).toHaveBeenCalledOnce();
  });

  it("should show the Pinchy logo", () => {
    const error = new Error("DB connection failed");
    render(<ErrorPage error={error} reset={mockReset} />);

    expect(screen.getByAltText("Pinchy")).toBeInTheDocument();
  });
});
