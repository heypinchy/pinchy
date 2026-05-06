/**
 * Tests for AddIntegrationDialog — MCP preset picker (Task 7.1)
 * and test-connection button (Task 7.2).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AddIntegrationDialog } from "@/components/add-integration-dialog";

// ── Sonner mock (toasts) ────────────────────────────────────────────────────
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ── docs-link mock ──────────────────────────────────────────────────────────
vi.mock("@/components/docs-link", () => ({
  docsUrl: (path: string) => `https://docs.heypinchy.com/${path}`,
}));

// ── hooks mock ──────────────────────────────────────────────────────────────
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ isCopied: false, copy: vi.fn() }),
}));

// ── fetch mock ──────────────────────────────────────────────────────────────
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderDialog(props: Partial<Parameters<typeof AddIntegrationDialog>[0]> = {}) {
  return render(
    <AddIntegrationDialog open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} {...props} />
  );
}

// ── Task 7.1: MCP preset picker ─────────────────────────────────────────────

describe("AddIntegrationDialog — MCP preset picker (Task 7.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows an 'MCP' option in the type picker", () => {
    renderDialog();
    expect(screen.getByText(/Generic MCP/i)).toBeInTheDocument();
  });

  it("selecting GitHub pre-fills the URL field with the GitHub MCP URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Click the MCP type button in the type picker
    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Now we are on the connect step — find the preset combobox (Radix Select renders as button with role=combobox)
    const presetSelector = screen.getByRole("combobox");
    await user.click(presetSelector);
    const githubOption = screen.getByRole("option", { name: /GitHub/i });
    await user.click(githubOption);

    // The URL field should be pre-filled
    const urlInput = screen.getByRole("textbox", { name: /URL/i });
    expect(urlInput).toHaveValue("https://api.githubcopilot.com/mcp/");
  });

  it("shows token instructions after selecting GitHub preset", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    const presetSelector = screen.getByRole("combobox");
    await user.click(presetSelector);
    const githubOption = screen.getByRole("option", { name: /GitHub/i });
    await user.click(githubOption);

    // Token instructions should be visible
    expect(screen.getByText(/Fine-Grained Personal Access Token/i)).toBeInTheDocument();
  });

  it("submit button is labelled 'Connect' for MCP types", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // The connect step should have a "Connect" submit button
    expect(screen.getByRole("button", { name: /^Connect$/i })).toBeInTheDocument();
  });

  it("submit button is disabled until token is entered", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Select GitHub so URL is pre-filled, but token still empty
    const presetSelector = screen.getByRole("combobox");
    await user.click(presetSelector);
    await user.click(screen.getByRole("option", { name: /GitHub/i }));

    const submitButton = screen.getByRole("button", { name: /^Connect$/i });
    expect(submitButton).toBeDisabled();
  });

  it("submit button is enabled once token is entered", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Select GitHub (URL pre-filled)
    const presetSelector = screen.getByRole("combobox");
    await user.click(presetSelector);
    await user.click(screen.getByRole("option", { name: /GitHub/i }));

    // Enter a token
    const tokenInput = screen.getByLabelText(/token/i);
    await user.type(tokenInput, "github_pat_sometoken");

    const submitButton = screen.getByRole("button", { name: /^Connect$/i });
    expect(submitButton).not.toBeDisabled();
  });

  it("Generic MCP shows URL, transport and token fields — all blank initially", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Generic is the default preset — URL should be empty
    const urlInput = screen.getByRole("textbox", { name: /URL/i });
    expect(urlInput).toHaveValue("");
  });

  it("token field is of type password", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    const tokenInput = screen.getByLabelText(/token/i);
    expect(tokenInput).toHaveAttribute("type", "password");
  });
});

// ── Task 7.2: Test connection button ─────────────────────────────────────────

describe("AddIntegrationDialog — Test connection button (Task 7.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows 'Test connection' button only for Generic MCP", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Generic is the default preset — test connection should be visible
    expect(screen.getByRole("button", { name: /Test connection/i })).toBeInTheDocument();
  });

  it("does NOT show 'Test connection' button for GitHub preset", async () => {
    const user = userEvent.setup();
    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Select GitHub preset
    const presetSelector = screen.getByRole("combobox");
    await user.click(presetSelector);
    await user.click(screen.getByRole("option", { name: /GitHub/i }));

    expect(screen.queryByRole("button", { name: /Test connection/i })).not.toBeInTheDocument();
  });

  it("clicking 'Test connection' calls POST /api/integrations/test and shows tool list", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tools: [
          { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
          { name: "create_issue", description: "Create issue", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Response);

    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Generic is the default preset
    // Fill in URL and token
    const urlInput = screen.getByRole("textbox", { name: /URL/i });
    await user.type(urlInput, "https://mcp.example.com/");
    const tokenInput = screen.getByLabelText(/token/i);
    await user.type(tokenInput, "tok-123");

    // Click test connection
    const testBtn = screen.getByRole("button", { name: /Test connection/i });
    await user.click(testBtn);

    // Verify API was called
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/test",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("mcp.example.com"),
        })
      );
    });

    // Verify tool list appears inline
    await waitFor(() => {
      expect(screen.getByText("list_repos")).toBeInTheDocument();
      expect(screen.getByText("create_issue")).toBeInTheDocument();
    });
  });

  it("shows error message when test connection fails", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Cannot connect to MCP server" }),
    } as unknown as Response);

    renderDialog();

    const mcpButton = screen.getByRole("button", { name: /Generic MCP/i });
    await user.click(mcpButton);

    // Generic is the default preset
    // Fill in URL and token
    await user.type(screen.getByRole("textbox", { name: /URL/i }), "https://mcp.example.com/");
    await user.type(screen.getByLabelText(/token/i), "tok-123");

    const testBtn = screen.getByRole("button", { name: /Test connection/i });
    await user.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText(/Cannot connect to MCP server/i)).toBeInTheDocument();
    });
  });
});
