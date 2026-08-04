// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsContext } from "@/components/settings-context";
import { CONTEXT_CONTENT_MAX_LENGTH, CONTEXT_TOO_LONG_MESSAGE } from "@/lib/schemas/context";

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

  describe("onDirtyChange callback", () => {
    it("should call onDirtyChange(false) on mount (initially clean)", () => {
      const onDirtyChange = vi.fn();
      render(
        <SettingsContext
          userContext="original"
          orgContext=""
          isAdmin={false}
          onDirtyChange={onDirtyChange}
        />
      );

      expect(onDirtyChange).toHaveBeenCalledWith(false);
    });

    it("should call onDirtyChange(true) when content is changed", () => {
      const onDirtyChange = vi.fn();
      render(
        <SettingsContext
          userContext="original"
          orgContext=""
          isAdmin={false}
          onDirtyChange={onDirtyChange}
        />
      );

      const textarea = screen.getByDisplayValue("original");
      fireEvent.change(textarea, { target: { value: "changed" } });

      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it("should call onDirtyChange(false) after content is successfully saved", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const onDirtyChange = vi.fn();
      render(
        <SettingsContext
          userContext="original"
          orgContext=""
          isAdmin={false}
          onDirtyChange={onDirtyChange}
        />
      );

      const textarea = screen.getByDisplayValue("original");
      fireEvent.change(textarea, { target: { value: "changed" } });

      expect(onDirtyChange).toHaveBeenCalledWith(true);

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      });
    });
  });

  it("updates displayed content when initialContent prop changes (async fetch)", () => {
    const { rerender } = render(<SettingsContext userContext="" orgContext="" isAdmin={false} />);

    // Initially empty
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("");

    // Simulate async fetch completing — parent passes new prop
    rerender(<SettingsContext userContext="Fetched context" orgContext="" isAdmin={false} />);

    expect(textarea).toHaveValue("Fetched context");
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

  it("surfaces the field-level reason from a structured validation error", async () => {
    // parseRequestBody's 400 puts the actionable text in details.fieldErrors —
    // `error` alone is the generic "Validation failed", which tells the user
    // nothing they can act on.
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        error: "Validation failed",
        details: {
          formErrors: [],
          fieldErrors: { content: [CONTEXT_TOO_LONG_MESSAGE] },
        },
      }),
    } as Response);

    render(<SettingsContext userContext="Some context" orgContext="" isAdmin={false} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(CONTEXT_TOO_LONG_MESSAGE)).toBeInTheDocument();
    });
    expect(screen.queryByText("Validation failed")).not.toBeInTheDocument();
  });

  describe("length limit", () => {
    it("does not show a character count for ordinary short content", () => {
      render(<SettingsContext userContext="Short" orgContext="" isAdmin={false} />);

      expect(screen.queryByText(/characters/i)).not.toBeInTheDocument();
    });

    it("shows the character count as the content approaches the limit", () => {
      const nearLimit = "a".repeat(CONTEXT_CONTENT_MAX_LENGTH - 100);
      render(<SettingsContext userContext={nearLimit} orgContext="" isAdmin={false} />);

      expect(screen.getByText(/15,900 \/ 16,000 characters/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
    });

    it("disables saving while the content is over the limit", () => {
      const tooLong = "a".repeat(CONTEXT_CONTENT_MAX_LENGTH + 1);
      render(<SettingsContext userContext={tooLong} orgContext="" isAdmin={false} />);

      expect(screen.getByText(/16,001 \/ 16,000 characters/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    });

    it("re-enables saving once the content is trimmed back under the limit", () => {
      const tooLong = "a".repeat(CONTEXT_CONTENT_MAX_LENGTH + 1);
      render(<SettingsContext userContext={tooLong} orgContext="" isAdmin={false} />);

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "trimmed" } });

      expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
    });
  });
});
