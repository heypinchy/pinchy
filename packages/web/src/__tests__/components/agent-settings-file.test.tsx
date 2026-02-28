import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("SOUL.md", () => {
    it("should render the SOUL.md explanation text", () => {
      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" />);

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
        />
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue("You are a helpful assistant.");
      expect(textarea).toHaveClass("font-mono");
    });

    it("should render a 'Save & restart' button", () => {
      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" />);

      expect(screen.getByRole("button", { name: "Save & restart" })).toBeInTheDocument();
    });

    it("should PUT to the correct API endpoint on save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(
        <AgentSettingsFile
          agentId="agent-1"
          filename="SOUL.md"
          content="You are a helpful assistant."
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1/files/SOUL.md", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "You are a helpful assistant." }),
        });
      });
    });

    it("should send updated content on save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="Original content" />);

      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Updated content" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1/files/SOUL.md", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Updated content" }),
        });
      });
    });

    it("should show success banner after save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" />);

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/saved\. changes will apply to your next conversation\./i)
        ).toBeInTheDocument();
      });
    });

    it("should hide success banner when content is edited again", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" />);

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/saved\. changes will apply to your next conversation\./i)
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "new edit" },
      });

      expect(
        screen.queryByText(/saved\. changes will apply to your next conversation\./i)
      ).not.toBeInTheDocument();
    });

    it("should show error feedback after failed save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Failed to save file" }),
      } as Response);

      render(<AgentSettingsFile agentId="agent-1" filename="SOUL.md" content="" />);

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to save file/i)).toBeInTheDocument();
      });
    });
  });

  describe("AGENTS.md", () => {
    it("should render the AGENTS.md explanation text", () => {
      render(<AgentSettingsFile agentId="agent-1" filename="AGENTS.md" content="" />);

      expect(screen.getByText(/operating instructions/i)).toBeInTheDocument();
    });

    it("should PUT to the AGENTS.md API endpoint on save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(
        <AgentSettingsFile agentId="agent-1" filename="AGENTS.md" content="Some instructions" />
      );

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1/files/AGENTS.md", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Some instructions" }),
        });
      });
    });
  });
});
