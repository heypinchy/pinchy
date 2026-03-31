import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";

vi.mock("@/components/odoo-permission-section", () => ({
  OdooPermissionSection: ({
    onChange,
  }: {
    agentId: string;
    onChange: (v: unknown, d: boolean) => void;
  }) => {
    // Simple stub that calls onChange with null on mount (no connection selected)
    void onChange;
    return <div data-testid="odoo-section">Odoo Section</div>;
  },
}));

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

  it("should render Knowledge Base heading with checkboxes for KB tools", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByLabelText("List approved directories")).toBeInTheDocument();
    expect(screen.getByLabelText("Read approved files")).toBeInTheDocument();
  });

  it("should not render odoo tools as checkboxes", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Odoo: Browse schema")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Odoo: Read data")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Odoo: Count records")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Odoo: Aggregate data")).not.toBeInTheDocument();
  });

  it("should not render Powerful Tools section (OpenClaw native tools removed)", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText("Powerful Tools")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/these tools give the agent direct access to your server/i)
    ).not.toBeInTheDocument();
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

  it("should render Odoo section", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Odoo")).toBeInTheDocument();
    expect(screen.getByTestId("odoo-section")).toBeInTheDocument();
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
          expect.objectContaining({
            allowedTools: expect.arrayContaining(["pinchy_ls"]),
            integrations: null,
          }),
          true
        );
      });
    });

    it("should call onChange with isDirty=false and integrations=null on mount when no changes", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          onChange={onChange}
        />
      );

      expect(onChange).toHaveBeenCalledWith(
        { allowedTools: [], allowedPaths: [], integrations: null },
        false
      );
    });
  });
});
