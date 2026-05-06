/**
 * Tests for McpPermissionSection — Task 7.3 (MCP tool checkboxes) and
 * Task 7.4 (drift toast, one-shot per drift event).
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { McpPermissionSection } from "@/components/mcp-permission-section";

// ── Sonner mock (toasts) ────────────────────────────────────────────────────
const mockToast = vi.fn();
vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

// ── fetch mock ──────────────────────────────────────────────────────────────
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMcpConnection(id: string, name: string, tools: string[] = ["tool_a", "tool_b"]) {
  return {
    id,
    name,
    type: "mcp" as const,
    status: "active" as const,
    data: {
      type: "mcp" as const,
      preset: "generic" as const,
      transport: "http" as const,
      url: `https://example.com/${id}`,
      tools: tools.map((t) => ({ name: t, description: `${t} description`, inputSchema: {} })),
      lastSyncAt: "2026-01-01T00:00:00Z",
    },
  };
}

function mockAgentPerms(
  mcpPerms: Array<{
    kind: "mcp";
    connectionId: string;
    connectionName: string;
    availableTools: string[];
    tools: string[];
  }> = [],
  drift: Array<{ connectionName: string; removedTool: string }> = []
) {
  fetchMock.mockImplementation((url: string) => {
    if (url.match(/\/api\/agents\/.*\/integrations/)) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            permissions: mcpPerms,
            drift,
          }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

// ── Task 7.3: MCP tool checkboxes ──────────────────────────────────────────

describe("McpPermissionSection — Task 7.3: MCP tool checkboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when no MCP connections provided", () => {
    mockAgentPerms();
    const { container } = render(
      <McpPermissionSection agentId="agent-1" connections={[]} onChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders tool checkboxes for a single MCP connection", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos", "create_issue"]);
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos", "create_issue"],
        tools: [],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
      expect(screen.getByLabelText("create_issue")).toBeInTheDocument();
    });
  });

  it("renders tool checkboxes for multiple MCP connections", async () => {
    const conn1 = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos"]);
    const conn2 = makeMcpConnection("mcp-2", "Linear MCP", ["list_issues", "create_issue"]);
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos"],
        tools: [],
      },
      {
        kind: "mcp",
        connectionId: "mcp-2",
        connectionName: "Linear MCP",
        availableTools: ["list_issues", "create_issue"],
        tools: [],
      },
    ]);

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

  it("pre-checks tools that are already granted", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos", "create_issue"]);
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos", "create_issue"],
        tools: ["list_repos"], // only list_repos is granted
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      const listReposCheckbox = screen.getByLabelText("list_repos");
      const createIssueCheckbox = screen.getByLabelText("create_issue");
      expect(listReposCheckbox).toBeChecked();
      expect(createIssueCheckbox).not.toBeChecked();
    });
  });

  it("toggling a checkbox calls onChange with updated tools", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos", "create_issue"]);
    const onChange = vi.fn();
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos", "create_issue"],
        tools: [],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText("list_repos"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "mcp",
            connectionId: "mcp-1",
            tools: expect.arrayContaining(["list_repos"]),
          }),
        ]),
        true // isDirty
      );
    });
  });

  it("toggling a checked checkbox unchecks it and updates onChange", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos", "create_issue"]);
    const onChange = vi.fn();
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos", "create_issue"],
        tools: ["list_repos"],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("list_repos")).toBeChecked();
    });

    await userEvent.click(screen.getByLabelText("list_repos"));

    await waitFor(() => {
      const lastCall = onChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "mcp",
            connectionId: "mcp-1",
            tools: [],
          }),
        ])
      );
    });
  });
});

// ── Task 7.4: drift toast ───────────────────────────────────────────────────

describe("McpPermissionSection — Task 7.4: drift toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows one toast per drift entry on initial render", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos"]);
    mockAgentPerms(
      [
        {
          kind: "mcp",
          connectionId: "mcp-1",
          connectionName: "GitHub MCP",
          availableTools: ["list_repos"],
          tools: [],
        },
      ],
      [{ connectionName: "GitHub MCP", removedTool: "old_tool" }]
    );

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        "Tool removed",
        expect.objectContaining({
          description: expect.stringContaining("old_tool"),
        })
      );
    });

    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it("shows one toast per drift entry when there are multiple drift entries", async () => {
    const conn1 = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos"]);
    const conn2 = makeMcpConnection("mcp-2", "Linear MCP", ["list_issues"]);
    mockAgentPerms(
      [
        {
          kind: "mcp",
          connectionId: "mcp-1",
          connectionName: "GitHub MCP",
          availableTools: ["list_repos"],
          tools: [],
        },
        {
          kind: "mcp",
          connectionId: "mcp-2",
          connectionName: "Linear MCP",
          availableTools: ["list_issues"],
          tools: [],
        },
      ],
      [
        { connectionName: "GitHub MCP", removedTool: "old_tool_a" },
        { connectionName: "Linear MCP", removedTool: "old_tool_b" },
      ]
    );

    render(
      <McpPermissionSection agentId="agent-1" connections={[conn1, conn2]} onChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledTimes(2);
    });
  });

  it("does NOT repeat drift toasts on re-render (dedupe via ref)", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos"]);
    mockAgentPerms(
      [
        {
          kind: "mcp",
          connectionId: "mcp-1",
          connectionName: "GitHub MCP",
          availableTools: ["list_repos"],
          tools: [],
        },
      ],
      [{ connectionName: "GitHub MCP", removedTool: "old_tool" }]
    );

    const { rerender } = render(
      <McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledTimes(1);
    });

    // Re-render the component (simulates navigating away and back)
    rerender(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    // Wait a tick to ensure no additional toasts were fired
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Still only 1 toast total
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it("shows no toast when drift is empty", async () => {
    const conn = makeMcpConnection("mcp-1", "GitHub MCP", ["list_repos"]);
    mockAgentPerms([
      {
        kind: "mcp",
        connectionId: "mcp-1",
        connectionName: "GitHub MCP",
        availableTools: ["list_repos"],
        tools: [],
      },
    ]);

    render(<McpPermissionSection agentId="agent-1" connections={[conn]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
    });

    expect(mockToast).not.toHaveBeenCalled();
  });
});
