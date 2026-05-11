import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPermissions } from "@/components/agent-settings-permissions";
import type { AgentPluginConfig } from "@/db/schema";

// Capture onChange callbacks from child sections so tests can simulate
// the post-save cascade where a sibling section's onChange fires and
// causes AgentSettingsPermissions to re-evaluate its dirty state.
let capturedOdooOnChange:
  | ((
      v: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null,
      isDirty: boolean
    ) => void)
  | null = null;
let capturedWebSearchOnChange: ((v: AgentPluginConfig["pinchy-web"]) => void) | null = null;

vi.mock("@/components/odoo-permission-section", () => ({
  OdooPermissionSection: ({
    onChange,
  }: {
    agentId: string;
    connections: unknown[];
    onChange: (
      v: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null,
      d: boolean
    ) => void;
  }) => {
    capturedOdooOnChange = onChange;
    return <div data-testid="odoo-section">Odoo Section</div>;
  },
}));

vi.mock("@/components/web-search-permission-section", () => ({
  WebSearchPermissionSection: ({
    onChange,
    showSecurityWarning,
  }: {
    config: unknown;
    onChange: (v: AgentPluginConfig["pinchy-web"]) => void;
    showSecurityWarning: boolean;
  }) => {
    capturedWebSearchOnChange = onChange;
    return (
      <div data-testid="web-search-section">
        Web Search Config
        {showSecurityWarning && <span data-testid="security-warning">Security Warning</span>}
      </div>
    );
  },
}));

vi.mock("@/components/email-permission-section", () => ({
  EmailPermissionSection: ({
    onChange,
  }: {
    agentId: string;
    connections: unknown[];
    onChange: (v: unknown, d: boolean) => void;
  }) => {
    void onChange;
    return <div data-testid="email-section">Email Section</div>;
  },
}));

beforeEach(() => {
  capturedOdooOnChange = null;
  capturedWebSearchOnChange = null;
});

describe("AgentSettingsPermissions", () => {
  const defaultAgent = {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-6",
    isPersonal: false,
    allowedTools: [] as string[],
    pluginConfig: null as import("@/db/schema").AgentPluginConfig | null,
  };

  const defaultDirectories = [
    { path: "/data/docs", name: "docs" },
    { path: "/data/reports", name: "reports" },
  ];

  const odooConnection = {
    id: "conn-odoo",
    name: "Odoo Sales",
    type: "odoo",
    status: "active",
    data: null,
  };
  const googleConnection = {
    id: "conn-google",
    name: "Google Workspace",
    type: "google",
    status: "active",
    data: null,
  };

  it("should render Knowledge Base heading with checkboxes for KB tools", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
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
        connections={[]}
        isAdmin={true}
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
        connections={[]}
        isAdmin={true}
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
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText("Allowed Directories")).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("List approved directories"));

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  it("should NOT show DirectoryPicker when no safe tools are checked", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText("Allowed Directories")).not.toBeInTheDocument();
  });

  it("should show DirectoryPicker when agent already has safe tools allowed", () => {
    const agentWithTools = {
      ...defaultAgent,
      allowedTools: ["pinchy_ls"],
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs"] } },
    };

    render(
      <AgentSettingsPermissions
        agent={agentWithTools}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  describe("conditional integration sections", () => {
    it("hides Odoo and Email sections when no integration connections exist", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByText("Odoo")).not.toBeInTheDocument();
      expect(screen.queryByTestId("odoo-section")).not.toBeInTheDocument();
      expect(screen.queryByText("Email")).not.toBeInTheDocument();
      expect(screen.queryByTestId("email-section")).not.toBeInTheDocument();
    });

    it("shows only Odoo section when only Odoo connection exists", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[odooConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByTestId("odoo-section")).toBeInTheDocument();
      expect(screen.queryByText("Email")).not.toBeInTheDocument();
      expect(screen.queryByTestId("email-section")).not.toBeInTheDocument();
    });

    it("shows only Email section when only Google connection exists", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[googleConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByTestId("email-section")).toBeInTheDocument();
      expect(screen.queryByText("Odoo")).not.toBeInTheDocument();
      expect(screen.queryByTestId("odoo-section")).not.toBeInTheDocument();
    });

    it("shows both Odoo and Email sections when both connections exist", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[odooConnection, googleConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByTestId("odoo-section")).toBeInTheDocument();
      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByTestId("email-section")).toBeInTheDocument();
    });

    it("ignores pending connections for section visibility", () => {
      const pendingGoogle = { ...googleConnection, status: "pending" };
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[pendingGoogle]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByText("Email")).not.toBeInTheDocument();
      expect(screen.queryByTestId("email-section")).not.toBeInTheDocument();
    });
  });

  describe("discovery link", () => {
    it("shows admin-only link to Integrations settings", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      const link = screen.getByRole("link", { name: /add an integration/i });
      expect(link).toHaveAttribute("href", "/settings?tab=integrations");
    });

    it("hides the discovery link when the viewer is not admin", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByRole("link", { name: /add an integration/i })).not.toBeInTheDocument();
    });
  });

  describe("vision warning", () => {
    it("shows vision warning when pinchy_read enabled and model lacks vision", () => {
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: ["pinchy_read"],
            pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs"] } },
            model: "ollama/llama3.1:8b",
          }}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
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
            pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs"] } },
            model: "anthropic/claude-sonnet-4-6",
          }}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
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
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );
      expect(screen.queryByText(/limited pdf support/i)).not.toBeInTheDocument();
    });
  });

  describe("Web Search section", () => {
    const webSearchConnection = { id: "ws-1", name: "Brave Search", type: "web-search" };

    it("should render Web Search heading with checkboxes for web tools", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Web Search")).toBeInTheDocument();
      expect(screen.getByLabelText("Search the web")).toBeInTheDocument();
      expect(screen.getByLabelText("Fetch web pages")).toBeInTheDocument();
    });

    it("should not show WebSearchPermissionSection when no web tool is checked", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByTestId("web-search-section")).not.toBeInTheDocument();
    });

    it("should show WebSearchPermissionSection when a web tool is checked", async () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      await userEvent.click(screen.getByLabelText("Search the web"));

      expect(screen.getByTestId("web-search-section")).toBeInTheDocument();
    });

    it("should show WebSearchPermissionSection when agent already has web tools allowed", () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_web_search"] }}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId("web-search-section")).toBeInTheDocument();
    });

    it("should show security warning when agent has web tools and file tools", () => {
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: ["pinchy_web_fetch", "pinchy_ls"],
            pluginConfig: { "pinchy-files": { allowed_paths: ["/data"] } },
          }}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId("security-warning")).toBeInTheDocument();
    });

    it("should not show security warning when agent has only web tools", () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_web_search"] }}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByTestId("security-warning")).not.toBeInTheDocument();
    });

    it("should include web tools in allowedTools onChange", async () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("Search the web"));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            allowedTools: expect.arrayContaining(["pinchy_web_search"]),
          }),
          true
        );
      });
    });
  });

  describe("onChange behavior", () => {
    it("should NOT render a Save button", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
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
          connections={[]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("List approved directories"));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            allowedTools: expect.arrayContaining(["pinchy_ls"]),
            integrations: [],
          }),
          true
        );
      });
    });

    it("should call onChange with isDirty=false and empty integrations on mount when no changes", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      expect(onChange).toHaveBeenCalledWith(
        { allowedTools: [], allowedPaths: [], integrations: [], webSearchConfig: {} },
        false
      );
    });

    it("should exclude email_* tools from KB tools and allowedTools output", () => {
      const onChange = vi.fn();
      const agentWithEmailTools = {
        ...defaultAgent,
        allowedTools: ["email_list", "email_read", "email_search", "email_draft"],
      };

      render(
        <AgentSettingsPermissions
          agent={agentWithEmailTools}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      expect(screen.queryByLabelText("Email: List messages")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Email: Read message")).not.toBeInTheDocument();

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: [],
        }),
        false
      );
    });
  });

  // Regression for #XXX: After a successful save the parent updates the
  // `agent` prop to reflect the persisted state, and refetched `connections`
  // cause sibling sections (Odoo/Email) to re-emit a fresh onChange. If the
  // child component's "initial values" snapshot is frozen at first mount,
  // that downstream onChange triggers a dirty-recheck against stale refs
  // and falsely marks the Permissions tab as dirty again.
  describe("dirty re-evaluation after agent prop is updated (post-save cascade)", () => {
    const webSearchConnection = { id: "ws-1", name: "Brave Search", type: "web-search" };

    it("clears dirty state for webSearchConfig when agent prop reflects saved value and Odoo cascade fires", async () => {
      const onChange = vi.fn();
      const initialAgent = {
        ...defaultAgent,
        allowedTools: ["pinchy_web_search"],
        pluginConfig: null as import("@/db/schema").AgentPluginConfig | null,
      };

      const { rerender } = render(
        <AgentSettingsPermissions
          agent={initialAgent}
          directories={defaultDirectories}
          connections={[odooConnection, webSearchConnection]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      // User changes Web Search config (e.g. picks a freshness window).
      await waitFor(() => expect(capturedWebSearchOnChange).not.toBeNull());
      act(() => capturedWebSearchOnChange!({ freshness: "pd" }));

      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ webSearchConfig: { freshness: "pd" } }),
          true
        );
      });

      onChange.mockClear();

      // Save completes: parent re-renders with agent reflecting the saved
      // pluginConfig and (because fetchData re-fetched) a fresh connections
      // array reference.
      rerender(
        <AgentSettingsPermissions
          agent={{
            ...initialAgent,
            pluginConfig: { "pinchy-web": { freshness: "pd" } },
          }}
          directories={defaultDirectories}
          connections={[{ ...odooConnection }, { ...webSearchConnection }]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      // In production the cascade fires because useOdooPermissions resets
      // its addedModels to a new Map reference, which propagates a fresh
      // onChange call up to AgentSettingsPermissions. Simulate that here.
      await waitFor(() => expect(capturedOdooOnChange).not.toBeNull());
      act(() => capturedOdooOnChange!({ connectionId: "conn-odoo", permissions: [] }, false));

      // After the cascade, the dirty state must reflect the new (saved)
      // agent prop — there are no unsaved changes anymore.
      await waitFor(() => {
        expect(onChange).toHaveBeenCalled();
        const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
        expect(lastCall[1]).toBe(false);
      });
    });

    it("clears dirty state for KB tools after the agent prop reflects the saved tools and a sibling onChange fires", async () => {
      const onChange = vi.fn();
      const initialAgent = {
        ...defaultAgent,
        allowedTools: [] as string[],
        pluginConfig: null as import("@/db/schema").AgentPluginConfig | null,
      };

      const { rerender } = render(
        <AgentSettingsPermissions
          agent={initialAgent}
          directories={defaultDirectories}
          connections={[odooConnection]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      // User checks a KB tool.
      await userEvent.click(screen.getByLabelText("List approved directories"));

      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ allowedTools: expect.arrayContaining(["pinchy_ls"]) }),
          true
        );
      });

      onChange.mockClear();

      // Save completes: parent passes new agent prop and a refetched
      // connections array.
      rerender(
        <AgentSettingsPermissions
          agent={{
            ...initialAgent,
            allowedTools: ["pinchy_ls"],
            pluginConfig: { "pinchy-files": { allowed_paths: [] } },
          }}
          directories={defaultDirectories}
          connections={[{ ...odooConnection }]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      // Sibling Odoo section emits a fresh onChange (simulating the load
      // effect re-running on the new connections reference).
      await waitFor(() => expect(capturedOdooOnChange).not.toBeNull());
      act(() => capturedOdooOnChange!({ connectionId: "conn-odoo", permissions: [] }, false));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalled();
        const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
        expect(lastCall[1]).toBe(false);
      });
    });

    it("re-marks dirty when the user reverts a saved web search config back to empty", async () => {
      const onChange = vi.fn();
      const initialAgent = {
        ...defaultAgent,
        allowedTools: ["pinchy_web_search"],
        pluginConfig: null as import("@/db/schema").AgentPluginConfig | null,
      };

      const { rerender } = render(
        <AgentSettingsPermissions
          agent={initialAgent}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      // User picks a freshness value.
      await waitFor(() => expect(capturedWebSearchOnChange).not.toBeNull());
      act(() => capturedWebSearchOnChange!({ freshness: "pd" }));

      // Simulate "saved".
      rerender(
        <AgentSettingsPermissions
          agent={{
            ...initialAgent,
            pluginConfig: { "pinchy-web": { freshness: "pd" } },
          }}
          directories={defaultDirectories}
          connections={[{ ...webSearchConnection }]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      onChange.mockClear();

      // User reverts the saved value back to empty.
      act(() => capturedWebSearchOnChange!({}));

      // Compared to the *saved* state ({ freshness: "pd" }), reverting to {}
      // is dirty again. If we incorrectly compare against the mount-time
      // snapshot ({}), this would be falsely reported as clean.
      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ webSearchConfig: {} }),
          true
        );
      });
    });
  });
});
