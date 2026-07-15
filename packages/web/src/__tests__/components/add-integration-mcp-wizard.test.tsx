/**
 * Tests for AddIntegrationDialog — MCP integration type cards (one card per
 * preset) and the resulting connect-step variants:
 *
 *  - Named-preset flow (GitHub / Linear / Atlassian / …): preset is
 *    prefilled, URL and transport are hidden, user enters only a token.
 *  - Custom server flow ("Custom MCP server" card): user picks a preset,
 *    enters URL, transport, and token.
 *
 * The "Test connection" button is available in both flows, and calls
 * POST /api/integrations/test-credentials (main's read-only pre-save probe
 * route — NOT a dedicated /api/integrations/test route).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ isCopied: false, copy: vi.fn() }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
  };
});

import { AddIntegrationDialog } from "@/components/add-integration-dialog";
import { apiPost, ApiError } from "@/lib/api-client";

function renderDialog(props: Partial<Parameters<typeof AddIntegrationDialog>[0]> = {}) {
  return render(
    <AddIntegrationDialog
      open={true}
      onOpenChange={vi.fn()}
      onSuccess={vi.fn()}
      mcpEnabled
      {...props}
    />
  );
}

describe("AddIntegrationDialog — MCP type cards", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
  });

  it("shows GitHub, Linear, Atlassian and Custom MCP server cards", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Linear/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Atlassian/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Custom MCP server/i })).toBeInTheDocument();
  });

  it("hides every MCP card when the flag is off", () => {
    renderDialog({ mcpEnabled: false });
    expect(screen.queryByRole("button", { name: /^GitHub$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Linear$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Atlassian$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Custom MCP server/i })).not.toBeInTheDocument();
    // Odoo (non-MCP) is still listed.
    expect(screen.getByRole("button", { name: /Odoo/i })).toBeInTheDocument();
  });
});

describe("AddIntegrationDialog — GitHub named-preset flow", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
  });

  it("hides the preset selector — the card already picked GitHub", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

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

  it("shows GitHub-specific setup guidance: token-page CTA, prefix hint, collapsed steps", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));

    const cta = screen.getByRole("link", { name: /Create a token on GitHub/i });
    expect(cta).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens");

    expect(screen.getByText(/github_pat_/i)).toBeInTheDocument();

    expect(screen.queryByText(/Generate new token/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Step-by-step guide/i }));
    expect(screen.getByText(/Generate new token/i)).toBeInTheDocument();
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

  it("submits with preset=github and the GitHub MCP URL via apiPost", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-1", type: "mcp" });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations",
        expect.objectContaining({
          type: "mcp",
          preset: "github",
          url: "https://api.githubcopilot.com/mcp/",
          token: "github_pat_sometoken",
        })
      );
    });
  });

  it("defaults the connection name to the brand name without an MCP suffix", async () => {
    // Users picked "GitHub" in the integrations picker — MCP is the transport,
    // an implementation detail that must not leak into the connection name
    // shown on the integrations card.
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-1", type: "mcp" });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations",
        expect.objectContaining({ name: "GitHub" })
      );
    });
  });
});

describe("AddIntegrationDialog — additional named presets", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
  });

  it("Atlassian card surfaces the admin-enable note, service-account caveat, and canonical token URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Atlassian/i }));

    expect(screen.getByRole("heading", { name: /Connect Atlassian/i })).toBeInTheDocument();
    expect(screen.getByText(/Enable API-token authentication/i)).toBeInTheDocument();
    expect(screen.getByText(/service-account/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /Create an API token in Atlassian/i });
    expect(cta).toHaveAttribute(
      "href",
      "https://id.atlassian.com/manage-profile/security/api-tokens"
    );
  });

  it("Stripe card submits with preset=stripe and the Stripe MCP URL", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-stripe", type: "mcp" });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Stripe/i }));
    await user.type(screen.getByLabelText(/token/i), "rk_test_abc123def456ghi789");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations",
        expect.objectContaining({ preset: "stripe", url: "https://mcp.stripe.com" })
      );
    });
  });

  it("HighLevel card mentions Private Integration Tokens and Sub-Accounts", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /HighLevel/i }));

    expect(screen.getByRole("heading", { name: /Connect HighLevel/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Private Integration Token/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sub-Account/i).length).toBeGreaterThan(0);
  });

  it("sends the Sub-Account (Location) ID as extraHeaders.locationId for HighLevel", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-ghl", type: "mcp" });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /HighLevel/i }));
    await user.type(screen.getByLabelText(/token/i), "pit-abc123");
    await user.type(screen.getByLabelText(/Sub-Account \(Location\) ID/i), "110411007T");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations",
        expect.objectContaining({
          preset: "highlevel",
          extraHeaders: { locationId: "110411007T" },
        })
      );
    });
  });

  it("blocks submit with an inline field error for HighLevel when the Sub-Account ID is missing", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /HighLevel/i }));
    await user.type(screen.getByLabelText(/token/i), "pit-abc123");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    expect(
      await screen.findByText(/Sub-Account \(Location\) ID is required for HighLevel/i)
    ).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalledWith("/api/integrations", expect.anything());
  });
});

describe("AddIntegrationDialog — Custom MCP server flow", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
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

describe("AddIntegrationDialog — Test connection", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
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

  it("calls POST /api/integrations/test-credentials and lists discovered tools (custom flow)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({
      success: true,
      tools: [
        { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
        { name: "create_issue", description: "Create issue", inputSchema: { type: "object" } },
      ],
    });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));
    await user.type(screen.getByRole("textbox", { name: /URL/i }), "https://mcp.example.com/");
    await user.type(screen.getByLabelText(/token/i), "tok-123");

    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations/test-credentials",
        expect.objectContaining({ type: "mcp", url: "https://mcp.example.com/", token: "tok-123" })
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

  it("calls POST /api/integrations/test-credentials with the preset's fixed URL (named flow)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({ success: true, tools: [] });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_sometoken");
    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations/test-credentials",
        expect.objectContaining({ url: "https://api.githubcopilot.com/mcp/" })
      );
    });
  });

  // PERSONALITY.md § Error Messages: users picked "GitHub" in the picker —
  // the raw protocol error ("MCP server returned 401 Unauthorized") is an
  // implementation detail they should never have to decode.
  it("translates a rejected token into a human-friendly, provider-named error (named flow)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({
      success: false,
      error: "MCP server returned 401 Unauthorized",
      code: "unauthorized",
    });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_expired");
    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/GitHub rejected this token/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/MCP server returned 401/i)).not.toBeInTheDocument();
  });

  it("keeps the raw error visible as a detail line in the custom flow", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValueOnce({
      success: false,
      error: "MCP server returned 401 Unauthorized",
      code: "unauthorized",
    });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));
    await user.type(screen.getByRole("textbox", { name: /URL/i }), "https://mcp.example.com/");
    await user.type(screen.getByLabelText(/token/i), "tok-123");
    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/The server rejected this token/i)).toBeInTheDocument();
    });
    // Custom-server admins run the server themselves — the raw response is
    // genuinely useful for debugging, so it stays visible as a detail line.
    expect(screen.getByText(/MCP server returned 401 Unauthorized/i)).toBeInTheDocument();
  });

  it("translates connect-submit failures the same way as test failures", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockRejectedValueOnce(
      new ApiError(502, "MCP discovery failed", undefined, {
        error: "MCP discovery failed",
        detail: "MCP server returned 401 Unauthorized",
        code: "unauthorized",
      })
    );

    renderDialog();

    await user.click(screen.getByRole("button", { name: /GitHub/i }));
    await user.type(screen.getByLabelText(/token/i), "github_pat_expired");
    await user.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(screen.getByText(/GitHub rejected this token/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/MCP discovery failed/i)).not.toBeInTheDocument();
  });
});

describe("AddIntegrationDialog — MCP initialType prop (picker page entry point)", () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset();
  });

  it("opens directly at the GitHub connect step when initialType='mcp-github'", () => {
    renderDialog({ initialType: "mcp-github" });

    expect(screen.queryByText("Add Integration")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Connect GitHub/i })).toBeInTheDocument();
  });

  it("back button closes the dialog instead of returning to type selection when initialType='mcp-github'", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ initialType: "mcp-github", onOpenChange });

    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens directly at the Custom MCP server connect step when initialType='mcp-custom'", () => {
    renderDialog({ initialType: "mcp-custom" });

    expect(screen.getByRole("heading", { name: /Connect MCP server/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
