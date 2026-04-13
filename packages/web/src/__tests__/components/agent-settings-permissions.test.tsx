import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";

// Mock the IntegrationPermissionSection to avoid fetch calls from the hook
vi.mock("@/components/integration-permission-section", () => ({
  IntegrationPermissionSection: ({
    label,
    onChange,
  }: {
    agentId: string;
    integrationType: string;
    label: string;
    onChange: (v: unknown, d: boolean) => void;
  }) => {
    void onChange;
    return <div data-testid={`integration-section-${label.toLowerCase()}`}>{label} Section</div>;
  },
}));

// Mock fetch for connections loading
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no connections → no integration sections shown
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
  global.fetch = mockFetch;
});

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

  it("should not render pipedrive tools as checkboxes", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Pipedrive: Browse schema")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pipedrive: Read data")).not.toBeInTheDocument();
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

  it("should render Odoo section when Odoo connections exist", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "conn-1", name: "My Odoo", type: "odoo", data: null }],
    });

    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByTestId("integration-section-odoo")).toBeInTheDocument();
    });
  });

  it("should render Pipedrive section when Pipedrive connections exist", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "conn-2", name: "My Pipedrive", type: "pipedrive", data: null }],
    });

    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Pipedrive")).toBeInTheDocument();
      expect(screen.getByTestId("integration-section-pipedrive")).toBeInTheDocument();
    });
  });

  it("should render both integration sections when both have connections", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "conn-1", name: "My Odoo", type: "odoo", data: null },
        { id: "conn-2", name: "My Pipedrive", type: "pipedrive", data: null },
      ],
    });

    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByText("Pipedrive")).toBeInTheDocument();
    });
  });

  it("should not render integration sections when no connections exist", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        onChange={vi.fn()}
      />
    );

    // Wait for connections to load
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/integrations");
    });

    expect(screen.queryByText("Odoo")).not.toBeInTheDocument();
    expect(screen.queryByText("Pipedrive")).not.toBeInTheDocument();
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
