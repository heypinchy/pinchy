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
