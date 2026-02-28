import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsContext } from "@/components/settings-context";

vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange: (v: string) => void;
    className?: string;
  }) => (
    <textarea
      className={`font-mono ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe("SettingsContext", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders Your Context section for all users", () => {
    render(<SettingsContext userContext="" orgContext="" isAdmin={false} />);

    expect(screen.getByText("Your Context")).toBeInTheDocument();
    expect(screen.getByText(/context about you/i)).toBeInTheDocument();
  });

  it("renders Organization Context section only when isAdmin is true", () => {
    render(<SettingsContext userContext="" orgContext="" isAdmin={true} />);

    expect(screen.getByText("Your Context")).toBeInTheDocument();
    expect(screen.getByText("Organization Context")).toBeInTheDocument();
  });

  it("does NOT render Organization Context when isAdmin is false", () => {
    render(<SettingsContext userContext="" orgContext="" isAdmin={false} />);

    expect(screen.queryByText("Organization Context")).not.toBeInTheDocument();
  });

  it("calls PUT /api/users/me/context when personal context is saved", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsContext userContext="My personal context" orgContext="" isAdmin={false} />);

    const saveButtons = screen.getAllByRole("button", { name: /save/i });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/me/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "My personal context" }),
      });
    });
  });

  it("calls PUT /api/settings/context when org context is saved", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsContext userContext="" orgContext="Org info" isAdmin={true} />);

    const saveButtons = screen.getAllByRole("button", { name: /save/i });
    // Second save button is for org context
    fireEvent.click(saveButtons[1]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/settings/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Org info" }),
      });
    });
  });

  it("shows success feedback after save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsContext userContext="" orgContext="" isAdmin={false} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/saved\. changes will apply to your next conversation\./i)
      ).toBeInTheDocument();
    });
  });

  it("shows error feedback on failure", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Something went wrong" }),
    } as Response);

    render(<SettingsContext userContext="" orgContext="" isAdmin={false} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });
});
