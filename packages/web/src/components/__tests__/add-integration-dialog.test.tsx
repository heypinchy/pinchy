/**
 * Tests for AddIntegrationDialog — MCP integration type cards (one card per
 * preset) and the resulting connect-step variants:
 *
 *  - Named-preset flow (GitHub / Notion / Linear): preset is prefilled,
 *    URL and transport are hidden, user enters only a token.
 *  - Custom server flow ("Custom MCP server" card): user picks a preset,
 *    enters URL, transport, and token.
 *
 * The "Test connection" button is available in both flows.
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

// ── Type picker: four MCP cards visible when the flag is on ─────────────────

describe("AddIntegrationDialog — MCP type cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows GitHub, Linear, Atlassian and Custom MCP server cards", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Linear/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Atlassian/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Custom MCP server/i })).toBeInTheDocument();
  });

  it("hides every MCP card when the flag is off", () => {
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "0");
    renderDialog();
    // None of the MCP cards should be present.
    expect(screen.queryByRole("button", { name: /^GitHub$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Linear$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Atlassian$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Custom MCP server/i })).not.toBeInTheDocument();
    // Odoo (non-MCP) is still listed.
    expect(screen.getByRole("button", { name: /Odoo/i })).toBeInTheDocument();
  });
});

// ── Named-preset flow: GitHub card ──────────────────────────────────────────

describe("AddIntegrationDialog — GitHub named-preset flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hides the preset selector — the card already picked GitHub", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    // No combobox should be visible — the preset is locked in by the card choice.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("hides the URL field — GitHub's URL is fixed", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    expect(screen.queryByRole("textbox", { name: /URL/i })).not.toBeInTheDocument();
  });

  it("shows the dialog title 'Connect GitHub'", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    expect(screen.getByRole("heading", { name: /Connect GitHub/i })).toBeInTheDocument();
  });

  it("shows GitHub-specific token instructions", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    // Both classic and fine-grained PATs are now documented as valid —
    // the heading mentions Personal Access Token at the top.
    expect(screen.getByText(/Personal Access Token/i)).toBeInTheDocument();
    // And the prefix hint covers both forms.
    expect(screen.getByText(/github_pat_/i)).toBeInTheDocument();
  });

  it("token field is type=password", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    expect(screen.getByLabelText(/token/i)).toHaveAttribute("type", "password");
  });

  it("Connect submit is disabled until a token is entered", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    const submit = screen.getByRole("button", { name: /^Connect$/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    expect(submit).not.toBeDisabled();
  });

  it("submits with preset=github and the GitHub MCP URL", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "conn-1", type: "mcp" }),
    } as unknown as Response);

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"preset":"github"'),
        })
      );
      // URL is the fixed GitHub MCP endpoint from the preset registry.
      const body = fetchMock.mock.calls.at(-1)?.[1]?.body as string;
      expect(body).toContain("https://api.githubcopilot.com/mcp/");
    });
  });

  it("defaults the connection name to the brand name without an MCP suffix", async () => {
    // Users picked "GitHub" in the integrations picker — MCP is the transport,
    // an implementation detail that must not leak into the connection name
    // shown on the integrations card.
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "conn-1", type: "mcp" }),
    } as unknown as Response);

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string) as {
        name: string;
      };
      expect(body.name).toBe("GitHub");
    });
  });
});

// ── Additional named presets ────────────────────────────────────────────────

describe("AddIntegrationDialog — additional named presets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // We pick three representative new presets — Atlassian (admin-enable
  // disclaimer + Jira/Confluence shared token), Stripe (restricted API key),
  // and HighLevel (Private Integration Token + Sub-Account). The other three
  // (GitLab, Cloudflare, Intercom) follow the same flow and are covered by
  // the preset-registry tests in lib/integrations/__tests__/mcp-presets.test.ts.

  it("Atlassian card surfaces the admin-enable note, service-account caveat, and canonical token URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Atlassian/i }));

    expect(screen.getByRole("heading", { name: /Connect Atlassian/i })).toBeInTheDocument();
    // Phase-1 copy explains both prerequisites: admin enables API-token auth,
    // and the user provisions a service account (personal tokens require
    // Basic auth which Phase 1 doesn't support).
    expect(screen.getByText(/Enable API-token authentication/i)).toBeInTheDocument();
    expect(screen.getByText(/service-account user/i)).toBeInTheDocument();
    // Look up the link by its exact visible label (markdown renders the URL
    // as the link text) and assert the href is exactly the canonical
    // Atlassian token URL. Avoiding a regex sidesteps CodeQL's unanchored-
    // host smell and gives a stricter check than a substring match.
    const tokenLink = screen.getByRole("link", {
      name: "id.atlassian.com/manage-profile/security/api-tokens",
    });
    expect(tokenLink).toHaveAttribute(
      "href",
      "https://id.atlassian.com/manage-profile/security/api-tokens"
    );
  });

  it("Stripe card submits with preset=stripe and the Stripe MCP URL", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "conn-stripe", type: "mcp" }),
    } as unknown as Response);

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Stripe/i }));
    await user.type(screen.getByLabelText(/token/i), "rk_test_abc123def456ghi789");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      const body = fetchMock.mock.calls.at(-1)?.[1]?.body as string;
      expect(body).toContain('"preset":"stripe"');
      expect(body).toContain("https://mcp.stripe.com");
    });
  });

  it("HighLevel card mentions Private Integration Tokens and Sub-Accounts", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /HighLevel/i }));

    expect(screen.getByRole("heading", { name: /Connect HighLevel/i })).toBeInTheDocument();
    // "Private Integration Token" appears more than once in the copy (once as
    // a bold callout, once as plural in the cap-limit note) — getAllByText
    // tolerates that.
    expect(screen.getAllByText(/Private Integration Token/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sub-Account/i).length).toBeGreaterThan(0);
  });
});

// ── Custom server flow ──────────────────────────────────────────────────────

describe("AddIntegrationDialog — Custom MCP server flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the preset selector — user may still pick a known preset", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));

    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("shows an empty URL field — user supplies their own server URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));

    const urlInput = screen.getByRole("textbox", { name: /URL/i });
    expect(urlInput).toBeInTheDocument();
    expect(urlInput).toHaveValue("");
  });

  it("switching the preset to GitHub from the dropdown prefills the URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /GitHub/i }));

    expect(screen.getByRole("textbox", { name: /URL/i })).toHaveValue(
      "https://api.githubcopilot.com/mcp/"
    );
  });
});

// ── Test-connection button (available in every MCP flow) ────────────────────

describe("AddIntegrationDialog — Test connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the 'Test connection' button in the GitHub flow", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    expect(screen.getByRole("button", { name: /Test connection/i })).toBeInTheDocument();
  });

  it("renders the 'Test connection' button in the Custom flow", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));

    expect(screen.getByRole("button", { name: /Test connection/i })).toBeInTheDocument();
  });

  it("calls POST /api/integrations/test and lists discovered tools (custom flow)", async () => {
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

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));
    await user.type(screen.getByRole("textbox", { name: /URL/i }), "https://mcp.example.com/");
    await user.type(screen.getByLabelText(/token/i), "tok-123");

    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/test",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("mcp.example.com"),
        })
      );
    });

    // Success is a single compact line. The full tool list is collapsed by
    // default — it's permission-UI material, not connect-flow material; large
    // servers (GitHub: ~50 tools) used to blow the dialog up into a wall of
    // text. It stays available behind "Show tools" for debugging.
    await waitFor(() => {
      expect(screen.getByText(/Connected — 2 tools available\./i)).toBeInTheDocument();
    });
    expect(screen.queryByText("list_repos")).not.toBeInTheDocument();
    expect(screen.queryByText("create_issue")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show tools/i }));

    expect(screen.getByText("list_repos")).toBeInTheDocument();
    expect(screen.getByText("create_issue")).toBeInTheDocument();
  });

  it("calls POST /api/integrations/test with the preset's fixed URL (named flow)", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tools: [] }),
    } as unknown as Response);

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      const body = fetchMock.mock.calls.at(-1)?.[1]?.body as string;
      expect(body).toContain("https://api.githubcopilot.com/mcp/");
    });
  });

  it("shows an inline error when the test fails", async () => {
    const user = userEvent.setup();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Cannot connect to MCP server" }),
    } as unknown as Response);

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));
    await user.type(screen.getByRole("textbox", { name: /URL/i }), "https://mcp.example.com/");
    await user.type(screen.getByLabelText(/token/i), "tok-123");
    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/Cannot connect to MCP server/i)).toBeInTheDocument();
    });
  });
});
