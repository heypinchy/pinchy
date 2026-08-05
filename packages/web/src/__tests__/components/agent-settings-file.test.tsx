// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSettingsFile } from "@/components/agent-settings-file";

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

describe("AgentSettingsFile", () => {
  describe("SOUL.md", () => {
    it("should render the SOUL.md explanation text", () => {
      render(
        <AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" onChange={vi.fn()} />
      );

      expect(
        screen.getByText(/this is your agent's personality and identity/i)
      ).toBeInTheDocument();
    });

    it("should render a textarea with monospace font pre-filled with content", () => {
      render(
        <AgentSettingsFile
          agentId="agent-1"
          filename="SOUL.md"
          content="You are a helpful assistant."
          onChange={vi.fn()}
        />
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue("You are a helpful assistant.");
      expect(textarea).toHaveClass("font-mono");
    });
  });

  describe("AGENTS.md", () => {
    it("should render the AGENTS.md explanation text", () => {
      render(
        <AgentSettingsFile agentId="agent-1" filename="AGENTS.md" content="" onChange={vi.fn()} />
      );

      expect(screen.getByText(/operating instructions/i)).toBeInTheDocument();
    });

    it("should link to the Instructions vs. Memory docs page", () => {
      render(
        <AgentSettingsFile agentId="agent-1" filename="AGENTS.md" content="" onChange={vi.fn()} />
      );

      const link = screen.getByRole("link", { name: /instructions vs\.? memory/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute(
        "href",
        "https://docs.heypinchy.com/explanation/instructions-vs-memory/"
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      // Should not include the legacy trailing arrow — uses the shared DocsLink convention.
      expect(link.textContent).not.toMatch(/→/);
    });
  });

  describe("onChange behavior", () => {
    it("should NOT render a Save button", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" onChange={onChange} />
      );
      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("should call onChange when content changes", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsFile
          agentId="agent-1"
          filename="SOUL.md"
          content="Original"
          onChange={onChange}
        />
      );

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated" } });

      expect(onChange).toHaveBeenCalledWith("Updated", true);
    });

    it("should call onChange with isDirty=false for unchanged content on mount", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsFile
          agentId="agent-1"
          filename="SOUL.md"
          content="Initial"
          onChange={onChange}
        />
      );
      expect(onChange).toHaveBeenCalledWith("Initial", false);
    });
  });
});

// #1144: "Save as instruction" carries a draft from a chat message into this
// editor. The subtlety is the BASELINE — the tab has to open dirty, or the
// user's Save is skipped as a no-op and the draft is silently lost.
describe("AgentSettingsFile with a carried-over draft", () => {
  it("appends the draft to the saved content rather than replacing it", () => {
    render(
      <AgentSettingsFile
        agentId="agent-1"
        filename="AGENTS.md"
        content="Answer in English."
        appendDraft="Score leads by VUE."
        onChange={vi.fn()}
      />
    );

    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.value).toBe("Answer in English.\n\nScore leads by VUE.\n");
  });

  it("opens dirty, so the pending Save actually writes", () => {
    const onChange = vi.fn();

    render(
      <AgentSettingsFile
        agentId="agent-1"
        filename="AGENTS.md"
        content="Answer in English."
        appendDraft="Score leads by VUE."
        onChange={onChange}
      />
    );

    expect(onChange).toHaveBeenCalledWith(
      "Answer in English.\n\nScore leads by VUE.\n",
      /* isDirty */ true
    );
  });

  it("keeps the SAVED content as the baseline, so deleting the draft is clean again", () => {
    // The regression this guards: folding the draft into the baseline would
    // make the appended text read as always-having-been-there — and then
    // reverting it by hand would look like an edit rather than an undo.
    const onChange = vi.fn();

    render(
      <AgentSettingsFile
        agentId="agent-1"
        filename="AGENTS.md"
        content="Answer in English."
        appendDraft="Score leads by VUE."
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Answer in English." },
    });

    expect(onChange).toHaveBeenLastCalledWith("Answer in English.", false);
  });

  it("behaves exactly as before when no draft was carried in", () => {
    const onChange = vi.fn();

    render(
      <AgentSettingsFile
        agentId="agent-1"
        filename="AGENTS.md"
        content="Answer in English."
        onChange={onChange}
      />
    );

    expect(screen.getByRole("textbox")).toHaveValue("Answer in English.");
    expect(onChange).toHaveBeenCalledWith("Answer in English.", false);
  });
});
