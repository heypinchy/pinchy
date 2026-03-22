import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";

describe("AgentSettingsPermissions", () => {
  const defaultAgent = {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-20250514",
    isPersonal: false,
    allowedTools: [] as string[],
    pluginConfig: null as { allowed_paths?: string[] } | null,
  };

  const defaultDirectories = [
    { path: "/data/docs", name: "docs" },
    { path: "/data/reports", name: "reports" },
  ];

  it("should render Safe Tools heading with checkboxes for safe tools", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Safe Tools")).toBeInTheDocument();
    expect(screen.getByLabelText("List approved directories")).toBeInTheDocument();
    expect(screen.getByLabelText("Read approved files")).toBeInTheDocument();
  });

  it("should render Powerful Tools heading with checkboxes for powerful tools", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Powerful Tools")).toBeInTheDocument();
    expect(screen.getByLabelText("Run shell commands")).toBeInTheDocument();
    expect(screen.getByLabelText("Read any file")).toBeInTheDocument();
    expect(screen.getByLabelText("Write any file")).toBeInTheDocument();
    expect(screen.getByLabelText("Read any PDF")).toBeInTheDocument();
    expect(screen.getByLabelText("Analyze any image")).toBeInTheDocument();
    expect(screen.getByLabelText("Generate images")).toBeInTheDocument();
    expect(screen.getByLabelText("Fetch web pages")).toBeInTheDocument();
    expect(screen.getByLabelText("Search the web")).toBeInTheDocument();
  });

  it("should show a warning message in the Powerful Tools section", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByText(/these tools give the agent direct access to your server/i)
    ).toBeInTheDocument();
  });

  it("should show DirectoryPicker when a safe tool is checked", async () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    // DirectoryPicker should not be visible initially (no safe tools checked)
    expect(screen.queryByText("Allowed Directories")).not.toBeInTheDocument();

    // Check a safe tool
    await userEvent.click(screen.getByLabelText("List approved directories"));

    // DirectoryPicker should now be visible
    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  it("should NOT show DirectoryPicker when no safe tools are checked", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText("Allowed Directories")).not.toBeInTheDocument();
  });

  it("should show DirectoryPicker when agent already has safe tools allowed", () => {
    const agentWithTools = {
      ...defaultAgent,
      allowedTools: ["pinchy_ls"],
      pluginConfig: { allowed_paths: ["/data/docs"] },
    };

    render(
      <AgentSettingsPermissions
        agent={agentWithTools}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  describe("vision warning", () => {
    it("shows vision warning when pinchy_read enabled and model lacks vision", () => {
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: ["pinchy_read"],
            pluginConfig: { allowed_paths: ["/data/docs"] },
            model: "ollama/llama3.1:8b",
          }}
          directories={defaultDirectories}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText(/limited pdf support/i)).toBeInTheDocument();
    });

    it("does not show warning when model supports vision", () => {
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: ["pinchy_read"],
            pluginConfig: { allowed_paths: ["/data/docs"] },
            model: "anthropic/claude-sonnet-4-6",
          }}
          directories={defaultDirectories}
          onChange={vi.fn()}
        />
      );
      expect(screen.queryByText(/limited pdf support/i)).not.toBeInTheDocument();
    });

    it("does not show warning when pinchy_read not enabled", () => {
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: [],
            pluginConfig: null,
            model: "ollama/llama3.1:8b",
          }}
          directories={defaultDirectories}
          onChange={vi.fn()}
        />
      );
      expect(screen.queryByText(/limited pdf support/i)).not.toBeInTheDocument();
    });
  });

  describe("onChange behavior", () => {
    it("should NOT render a Save button", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          onChange={onChange}
        />
      );
      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("should call onChange when a tool is toggled", async () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("List approved directories"));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ allowedTools: expect.arrayContaining(["pinchy_ls"]) }),
          true
        );
      });
    });

    it("should call onChange with isDirty=false on mount when no changes", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          onChange={onChange}
        />
      );

      expect(onChange).toHaveBeenCalledWith({ allowedTools: [], allowedPaths: [] }, false);
    });
  });
});
