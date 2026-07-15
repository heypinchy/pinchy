import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import {
  McpPermissionSection,
  type McpPermissionConnection,
} from "@/components/mcp-permission-section";

// ── Sonner mock (toasts) ────────────────────────────────────────────────────
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

// ── api-client mock ─────────────────────────────────────────────────────────
const apiGetMock = vi.fn();
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiGet: (...args: Parameters<typeof actual.apiGet>) => apiGetMock(...args),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMcpConnection(
  id: string,
  name: string,
  tools: Array<{ name: string; description?: string }> = [
    { name: "tool_a", description: "tool_a description" },
    { name: "tool_b", description: "tool_b description" },
  ]
): McpPermissionConnection {
  return {
    id,
    name,
    type: "mcp",
    status: "active",
    data: {
      type: "mcp",
      preset: "generic",
      transport: "http",
      url: `https://example.com/${id}`,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: {} })),
      lastSyncAt: "2026-01-01T00:00:00Z",
    },
  };
}

/** Mock GET /api/agents/:agentId/integrations to return the given entries. */
function mockAgentIntegrations(
  entries: Array<{
    connectionId: string;
    connectionType: string;
    permissions: Array<{ model: string; operation: string }>;
  }> = []
) {
  apiGetMock.mockResolvedValue(entries);
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockToastError.mockReset();
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("McpPermissionSection — rendering", () => {
  it("renders nothing when no MCP connections provided", () => {
    mockAgentIntegrations();
    const { container } = render(
      <McpPermissionSection agentId="agent-1" connections={[]} onChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("renders tool checkboxes for a single MCP connection", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "list_repos description" },
      { name: "create_issue", description: "create_issue description" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
      expect(screen.getByLabelText("create_issue")).toBeInTheDocument();
    });
    expect(apiGetMock).toHaveBeenCalledWith("/api/agents/agent-1/integrations");
  });

  it("renders tool checkboxes for multiple MCP connections", async () => {
    const conn1 = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "" },
    ]);
    const conn2 = makeMcpConnection("mcp-2", "Linear MCP", [
      { name: "list_issues", description: "" },
      { name: "create_issue", description: "" },
    ]);
    mockAgentIntegrations();

    render(
      <McpPermissionSection agentId="agent-1" connections={[conn1, conn2]} onChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
      expect(screen.getByText("Linear MCP")).toBeInTheDocument();
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
      expect(screen.getByLabelText("list_issues")).toBeInTheDocument();
      expect(screen.getByLabelText("create_issue")).toBeInTheDocument();
    });
  });

  it("shows each tool's description, not just its name", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "list_repos does a thing" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("list_repos does a thing")).toBeInTheDocument();
    });
  });

  it("clamps tool descriptions and exposes the full text via a title tooltip", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "list_repos does a thing" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      const desc = screen.getByText("list_repos does a thing");
      expect(desc).toHaveClass("line-clamp-2");
      // `block` would override line-clamp's `display:-webkit-box` and silently
      // kill the clamp. Guard against re-adding it.
      expect(desc).not.toHaveClass("block");
      expect(desc).toHaveAttribute("title", "list_repos does a thing");
    });
  });

  it("shows a 'no tools' message when the connection has zero synced tools", async () => {
    const conn = makeMcpConnection("mcp-1", "Fresh MCP", []);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/no tools available\. sync the connection in settings/i)
      ).toBeInTheDocument();
    });
  });

  it("does not crash and renders a defined empty state when data is null (undecryptable row)", async () => {
    const conn: McpPermissionConnection = {
      id: "mcp-1",
      name: "Broken MCP",
      type: "mcp",
      status: "active",
      data: null,
    };
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Broken MCP")).toBeInTheDocument();
      expect(
        screen.getByText(/no tools available\. sync the connection in settings/i)
      ).toBeInTheDocument();
    });
  });
});

// ── Granting / toggling ──────────────────────────────────────────────────────

describe("McpPermissionSection — granting and toggling tools", () => {
  it("pre-checks tools that are already granted", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "" },
      { name: "create_issue", description: "" },
    ]);
    mockAgentIntegrations([
      {
        connectionId: "mcp-1",
        connectionType: "mcp",
        permissions: [{ model: "mcp", operation: "list_repos" }],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeChecked();
      expect(screen.getByLabelText("create_issue")).not.toBeChecked();
    });
  });

  it("toggling a checkbox calls onChange with the tool added, model 'mcp'", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "" },
      { name: "create_issue", description: "" },
    ]);
    const onChange = vi.fn();
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText("list_repos"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        [
          {
            connectionId: "mcp-1",
            permissions: [{ model: "mcp", operation: "list_repos" }],
          },
        ],
        true
      );
    });
  });

  it("toggling a checked checkbox off updates onChange and clears isDirty when back to initial", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos", description: "" },
    ]);
    const onChange = vi.fn();
    mockAgentIntegrations([
      {
        connectionId: "mcp-1",
        connectionType: "mcp",
        permissions: [{ model: "mcp", operation: "list_repos" }],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeChecked();
    });

    await userEvent.click(screen.getByLabelText("list_repos"));

    // Unchecking the only granted tool leaves a RELEVANT connection (it had
    // an initial grant) with an EMPTY permissions array — this is the entry
    // that must reach the server as an explicit clearing PUT, not be dropped.
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([{ connectionId: "mcp-1", permissions: [] }], true);
    });

    await userEvent.click(screen.getByLabelText("list_repos"));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [{ connectionId: "mcp-1", permissions: [{ model: "mcp", operation: "list_repos" }] }],
        false
      );
    });
  });

  it("omits a connection from onChange entirely when it has never had any grant (untouched)", async () => {
    const conn1 = makeMcpConnection("mcp-1", "GitHub MCP", [{ name: "list_repos" }]);
    const conn2 = makeMcpConnection("mcp-2", "Linear MCP", [{ name: "list_issues" }]);
    const onChange = vi.fn();
    // Only mcp-1 has a grant; mcp-2 has none and is never touched by the user.
    mockAgentIntegrations([
      {
        connectionId: "mcp-1",
        connectionType: "mcp",
        permissions: [{ model: "mcp", operation: "list_repos" }],
      },
    ]);

    render(
      <McpPermissionSection agentId="agent-1" connections={[conn1, conn2]} onChange={onChange} />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        [{ connectionId: "mcp-1", permissions: [{ model: "mcp", operation: "list_repos" }] }],
        false
      );
    });
  });

  it("select-all in a group toggles every tool in that group", async () => {
    const onChange = vi.fn();
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "pull_request_read" },
      { name: "merge_pull_request" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Select all Pull Requests tools")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText("Select all Pull Requests tools"));

    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)?.[0];
      const ops = last?.[0]?.permissions.map((p: { operation: string }) => p.operation);
      expect(ops).toEqual(expect.arrayContaining(["pull_request_read", "merge_pull_request"]));
    });
  });

  it("groups verb-prefixed names cleanly without garbage headers", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "create_or_update_file" },
      { name: "get_me" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("create_or_update_file")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Select all Files & Branches tools")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select all Or tools")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all Me tools")).not.toBeInTheDocument();
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe("McpPermissionSection — search", () => {
  it("filters the tool list by a search query", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [
      { name: "list_repos" },
      { name: "create_issue" },
    ]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("create_issue")).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText("Search GitHub MCP tools"), "repos");

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
      expect(screen.queryByLabelText("create_issue")).not.toBeInTheDocument();
    });
  });

  it("shows a no-match message for a query with zero results", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [{ name: "list_repos" }]);
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText("Search GitHub MCP tools"), "nonexistent-tool-xyz");

    await waitFor(() => {
      expect(screen.getByText(/no tools match/i)).toBeInTheDocument();
    });
  });
});

// ── Drift: a granted tool no longer present in the synced tool list ────────

describe("McpPermissionSection — drift (granted tool removed from a later sync)", () => {
  it("does not render a checkbox or count a drifted tool as granted", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [{ name: "list_repos" }]);
    const onChange = vi.fn();
    // The DB still has a grant for "old_tool", which the connection no
    // longer advertises (it was removed/renamed on a later sync).
    mockAgentIntegrations([
      {
        connectionId: "mcp-1",
        connectionType: "mcp",
        permissions: [
          { model: "mcp", operation: "list_repos" },
          { model: "mcp", operation: "old_tool" },
        ],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeChecked();
    });
    expect(screen.queryByLabelText("old_tool")).not.toBeInTheDocument();

    // The intersection with data.tools drops "old_tool" from BOTH initial and
    // checked, so the mount-time emission is clean and not falsely dirty.
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        [{ connectionId: "mcp-1", permissions: [{ model: "mcp", operation: "list_repos" }] }],
        false
      );
    });
  });
});

// ── Load failure ─────────────────────────────────────────────────────────────

describe("McpPermissionSection — load failure", () => {
  it("shows a toast and still renders the (unchecked) tool list when the GET fails", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [{ name: "list_repos" }]);
    apiGetMock.mockRejectedValue(new Error("network down"));

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
      expect(screen.getByLabelText("list_repos")).not.toBeChecked();
    });
  });
});

// ── Mount-time onChange contract ────────────────────────────────────────────

describe("McpPermissionSection — mount-time onChange", () => {
  it("calls onChange with an empty array and isDirty=false when nothing is granted", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", [{ name: "list_repos" }]);
    const onChange = vi.fn();
    mockAgentIntegrations();

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([], false);
    });
  });
});
