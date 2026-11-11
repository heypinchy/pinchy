// @vitest-environment jsdom
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

vi.mock("@/lib/model-vision", () => ({
  isModelVisionCapable: vi.fn((modelId: string) => modelId.startsWith("anthropic/")),
  setOllamaLocalVisionModels: vi.fn().mockResolvedValue(undefined),
}));

// The component now derives vision capability from useModelCapabilities,
// not from a sync helper. Mirror that by mocking the hook to return a map
// where anthropic models have vision and everything else doesn't.
vi.mock("@/hooks/use-model-capabilities", () => ({
  useModelCapabilities: () => ({
    data: new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (typeof prop !== "string") return undefined;
          const isVision = prop.startsWith("anthropic/");
          return {
            vision: isVision,
            documents: isVision,
            longContext: isVision,
            tools: true,
          };
        },
      }
    ),
    isLoading: false,
    error: undefined,
    refetch: vi.fn(),
  }),
}));

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

// Captured so wiring tests can assert WHAT the parent feeds the reindex
// section (saved grants, not the unsaved picker selection) without pulling the
// section's own fetch/poll machinery into this suite.
let capturedReindexProps: {
  agentId: string;
  allowedPathCount: number;
  hasUnsavedPathChanges?: boolean;
  savedPathsKey?: string;
} | null = null;

vi.mock("@/components/knowledge-reindex-section", () => ({
  KnowledgeReindexSection: (props: {
    agentId: string;
    allowedPathCount: number;
    hasUnsavedPathChanges?: boolean;
    savedPathsKey?: string;
  }) => {
    capturedReindexProps = props;
    return <div data-testid="knowledge-reindex-section" />;
  },
}));

// Which saved grants still exist is the server's answer (#1363); the hook has
// its own tests. Here it only matters that the tab asks for it and hands the
// answer to the picker.
const mockUseGrantedFolders = vi.fn();
vi.mock("@/hooks/use-granted-folders", () => ({
  useGrantedFolders: (...args: unknown[]) => mockUseGrantedFolders(...args),
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
  mockUseGrantedFolders.mockReset();
  mockUseGrantedFolders.mockReturnValue(undefined);
  capturedOdooOnChange = null;
  capturedWebSearchOnChange = null;
  capturedReindexProps = null;
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

  it("renders the three permission sections", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    // By role, not by text: "Memory" is both the section heading and the
    // checkbox label inside it, which is exactly the shape we want.
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Knowledge Base" })).toBeInTheDocument();
    expect(screen.getByLabelText("Memory")).toBeInTheDocument();
    expect(screen.getByLabelText("Create files")).toBeInTheDocument();
  });

  it("offers subfolder browsing only with the admin flag (#1269)", () => {
    // The subfolder listing route is admin-only. The settings page renders
    // this tab for admins only today; the flag keeps the chevrons off should
    // that ever change, since without it they could only ever answer 403.
    const { rerender } = render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );
    expect(screen.getAllByRole("button", { name: /^Show subfolders of / }).length).toBe(
      defaultDirectories.length
    );

    rerender(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /^Show subfolders of / })).not.toBeInTheDocument();
  });

  it("marks a saved grant whose folder is gone, for admins (#1363)", () => {
    mockUseGrantedFolders.mockReturnValue([
      { path: "/data/docs", status: "available" },
      { path: "/data/old-docs", status: "missing" },
    ]);
    const agent = {
      ...defaultAgent,
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs", "/data/old-docs"] } },
    };
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentSettingsPermissions
        agent={agent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={onChange}
      />
    );

    expect(mockUseGrantedFolders).toHaveBeenLastCalledWith(
      "agent-1",
      "/data/docs|/data/old-docs",
      true
    );
    expect(screen.getByText(/Folder not found/)).toBeInTheDocument();

    // Removing it is an ordinary unsaved change: Save sends it through the
    // agent update route, which audits the change in folder access.
    act(() => {
      screen.getByRole("button", { name: "Remove /data/old-docs" }).click();
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedPaths: ["/data/docs"] }),
      true
    );

    rerender(
      <AgentSettingsPermissions
        agent={agent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={false}
        onChange={vi.fn()}
      />
    );
    expect(mockUseGrantedFolders).toHaveBeenLastCalledWith(
      "agent-1",
      "/data/docs|/data/old-docs",
      false
    );
  });

  it("keeps the memory toggle out of the Knowledge Base section", () => {
    // Memory is not a knowledge-base concern. It appeared under that heading
    // only because this component dumped every non-integration powerful tool
    // there, which is how an agent's memory switch came to read "Write files"
    // and sit next to the directory picker (#755).
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    const memoryCheckbox = screen.getByLabelText("Memory");
    const kbSection = screen.getByRole("heading", { name: "Knowledge Base" }).closest("section");
    expect(kbSection).not.toBeNull();
    expect(kbSection!.contains(memoryCheckbox)).toBe(false);
  });

  it("states that knowledge base directories are read-only", () => {
    // Structurally true — build.ts never puts an admin path in write_paths —
    // and users had no way to know it.
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/can never write to them/i)).toBeInTheDocument();
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

  it("should show DirectoryPicker when directories are provided", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  // With nothing mounted, the section used to drop the picker and leave an
  // Index block saying "grant a directory" with nothing to grant. The empty
  // state says where directories come from instead (#1305).
  it("explains how to make directories available when none are mounted", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={[]}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
    expect(screen.getByText(/mounted under/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "docs" })).not.toBeInTheDocument();
  });

  it("should show DirectoryPicker when agent has allowed paths configured", () => {
    const agentWithPaths = {
      ...defaultAgent,
      allowedTools: [],
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs"] } },
    };

    render(
      <AgentSettingsPermissions
        agent={agentWithPaths}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("Allowed Directories")).toBeInTheDocument();
  });

  it("shows a grant stored with a trailing slash as checked and revokes it cleanly", async () => {
    // The stored grant is "/data/docs/"; the directory list says "/data/docs".
    // The admin must see the grant and be able to untick it (#1264).
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AgentSettingsPermissions
        agent={{
          ...defaultAgent,
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
        }}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={onChange}
      />
    );

    const docs = screen.getByRole("checkbox", { name: "docs" });
    expect(docs).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedPaths: ["/data/docs/"] }),
      false
    );

    await user.click(docs);

    expect(docs).not.toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allowedPaths: [] }), true);
  });

  it("does not report a re-ticked trailing-slash grant as an unsaved change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AgentSettingsPermissions
        agent={{
          ...defaultAgent,
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
        }}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={onChange}
      />
    );

    const docs = screen.getByRole("checkbox", { name: "docs" });
    await user.click(docs);
    await user.click(docs);

    expect(docs).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedPaths: ["/data/docs"] }),
      false
    );
    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();
  });

  it("gates the reindex section on SAVED grants, not the unsaved picker selection", async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(capturedReindexProps).toMatchObject({ agentId: "agent-1", allowedPathCount: 0 });
    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();

    // Tick a directory WITHOUT saving: the server still sees zero grants, so
    // the reindex gate must not open — and the picker says the change is
    // not in effect yet, next to the checkbox that made it (#1305).
    await user.click(screen.getByRole("checkbox", { name: "docs" }));

    // Reindex is held back until the change is saved, because it would run
    // over the OLD folders — the product owner read the earlier "a reindex
    // uses the saved grants" and could not tell what it meant.
    expect(capturedReindexProps).toMatchObject({
      allowedPathCount: 0,
      hasUnsavedPathChanges: true,
    });
    const notice = screen.getByText(/not saved yet/i);
    // Named, and in terms of what the agent will do, not of grants.
    expect(notice).toHaveTextContent(/once you save, the agent starts reading docs/i);
    expect(notice).toHaveTextContent(/next reindex/i);
    // Between the folders and the Index block, not inside the latter.
    const picker = screen.getByRole("group", { name: "Allowed Directories" });
    const index = screen.getByTestId("knowledge-reindex-section");
    expect(picker.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(index) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("feeds the reindex section the saved grant count for an agent with saved paths", () => {
    const agentWithPaths = {
      ...defaultAgent,
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs", "/data/reports"] } },
    };

    render(
      <AgentSettingsPermissions
        agent={agentWithPaths}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    expect(capturedReindexProps).toMatchObject({
      allowedPathCount: 2,
      savedPathsKey: "/data/docs|/data/reports",
    });
    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();
  });

  it("hides the reindex section for non-admins", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={false}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId("knowledge-reindex-section")).not.toBeInTheDocument();
  });

  it("says which saved directory the agent stops reading, and that nothing is deleted", async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsPermissions
        agent={{
          ...defaultAgent,
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs", "/data/reports"] } },
        }}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "reports" }));

    const notice = screen.getByText(/not saved yet/i);
    expect(notice).toHaveTextContent(/the agent stops reading reports/i);
    expect(notice).toHaveTextContent(/documents from folders you untick stay in the index/i);
    expect(notice).not.toHaveTextContent(/starts reading/i);
  });

  it("doesn't say the agent stops reading a subfolder its new parent grant covers (#1269)", async () => {
    // Ticking a folder folds the grants below it into one: the stored list
    // loses "/data/docs/2026/", but the agent still reads it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ directories: [], truncated: false })))
    );
    const user = userEvent.setup();
    render(
      <AgentSettingsPermissions
        agent={{
          ...defaultAgent,
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/2026/"] } },
        }}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "docs" }));

    const notice = screen.getByText(/not saved yet/i);
    expect(notice).toHaveTextContent(/the agent starts reading docs\./i);
    expect(notice).not.toHaveTextContent(/stops reading/i);
    expect(notice).not.toHaveTextContent(/untick/i);
    vi.unstubAllGlobals();
  });

  it("names both directions when folders are added and removed in one change", async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsPermissions
        agent={{
          ...defaultAgent,
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/reports"] } },
        }}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "docs" }));
    await user.click(screen.getByRole("checkbox", { name: "reports" }));

    expect(screen.getByText(/not saved yet/i)).toHaveTextContent(
      /once you save, the agent starts reading docs, and it stops reading reports\./i
    );
  });

  // A non-admin has no Reindex button, so the notice must not point at one.
  it("tells a non-admin about unsaved directory changes without mentioning reindexing", async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={defaultDirectories}
        connections={[]}
        isAdmin={false}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "docs" }));

    const notice = screen.getByText(/not saved yet/i);
    expect(notice).not.toHaveTextContent(/reindex/i);
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

  describe("Web Search section", () => {
    const webSearchConnection = { id: "ws-1", name: "Brave Search", type: "web-search" };

    // #1297: an agent from a web template keeps its web tools on an instance
    // without a search provider. The section must stay visible (otherwise
    // the grant is invisible and cannot be revoked) and say what is missing.
    it("shows the agent's web tools and a setup notice when no search provider exists", () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_web_search", "pinchy_web_fetch"] }}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Web Search")).toBeInTheDocument();
      expect(screen.getByLabelText("Search the web")).toBeChecked();
      expect(screen.getByLabelText("Fetch web pages")).toBeChecked();
      expect(screen.getByText("Web search isn't set up")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /set up web search/i })).toHaveAttribute(
        "href",
        "/settings?tab=integrations"
      );
    });

    it("keeps the web section while the last web tool is unchecked before saving", async () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_web_search", "pinchy_web_fetch"] }}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      await userEvent.click(screen.getByLabelText("Search the web"));
      await userEvent.click(screen.getByLabelText("Fetch web pages"));

      expect(screen.getByText("Web Search")).toBeInTheDocument();
      expect(screen.getByLabelText("Fetch web pages")).not.toBeChecked();
    });

    it("hides the web section when there is no search provider and no web tool", () => {
      render(
        <AgentSettingsPermissions
          agent={defaultAgent}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByText("Web Search")).not.toBeInTheDocument();
    });

    it("shows no setup notice when a search provider exists", () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_web_search"] }}
          directories={defaultDirectories}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByText("Web search isn't set up")).not.toBeInTheDocument();
    });

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
            allowedTools: ["pinchy_web_fetch"],
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

    it("does not show security warning when write is enabled but no directories configured", () => {
      render(
        <AgentSettingsPermissions
          agent={{ ...defaultAgent, allowedTools: ["pinchy_write", "pinchy_web_search"] }}
          directories={[]}
          connections={[webSearchConnection]}
          isAdmin={true}
          onChange={vi.fn()}
        />
      );

      // pinchy_write alone (no allowed_paths, no odoo/email integration) does
      // not constitute sensitive data access — security warning should not appear
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

      await userEvent.click(screen.getByLabelText("Create files"));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            allowedTools: expect.arrayContaining(["pinchy_write"]),
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
        {
          allowedTools: [],
          allowedPaths: [],
          integrations: [],
          webSearchConfig: {},
          confirm: {},
        },
        false
      );
    });

    // The read side of the #1133 storage switch, at the form. An agent whose
    // admin ticked confirmations before the upgrade carries `confirmTools`;
    // opening the page must show that policy rather than an empty one, because
    // the next save persists whatever the form is holding — an empty form
    // would silently write the policy away.
    it("loads a pre-#1133 confirmTools policy into the form", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPermissions
          agent={{
            ...defaultAgent,
            allowedTools: ["pinchy_web_search"],
            pluginConfig: { "pinchy-approvals": { confirmTools: ["pinchy_web_search"] } },
          }}
          directories={defaultDirectories}
          connections={[]}
          isAdmin={true}
          onChange={onChange}
        />
      );

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ confirm: { pinchy_web_search: "confirm" } }),
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

  it("renders Knowledge Base directory picker independent of pinchy_ls/pinchy_read toggles", () => {
    render(
      <AgentSettingsPermissions
        agent={{ ...defaultAgent, allowedTools: [] /* no fs tools at all */ }}
        directories={[{ path: "/data/kb", name: "kb" }]}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );
    // KB-Picker visible even without fs permissions
    expect(screen.getByText(/knowledge base/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /kb/i })).toBeInTheDocument();
  });

  it("renders the pinchy_write toggle in the Workspace section", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={[]}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Create files")).toBeInTheDocument();
  });

  it("does not render pinchy_ls or pinchy_read toggles", () => {
    render(
      <AgentSettingsPermissions
        agent={defaultAgent}
        directories={[]}
        connections={[]}
        isAdmin={true}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/list approved directories/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/read approved files/i)).not.toBeInTheDocument();
  });

  // After a successful save the parent updates the `agent` prop to reflect
  // the persisted state, and refetched `connections` cause sibling sections
  // (Odoo/Email) to re-emit a fresh onChange. If the child component's
  // "initial values" snapshot is frozen at first mount, that downstream
  // onChange triggers a dirty-recheck against stale refs and falsely marks
  // the Permissions tab as dirty again.
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

      // User checks the pinchy_write tool.
      await userEvent.click(screen.getByLabelText("Create files"));

      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ allowedTools: expect.arrayContaining(["pinchy_write"]) }),
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
            allowedTools: ["pinchy_write"],
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
