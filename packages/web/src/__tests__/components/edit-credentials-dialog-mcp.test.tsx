import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditCredentialsDialog } from "@/components/edit-credentials-dialog";
import type { IntegrationConnection } from "@/lib/integrations/types";

// Regression: the Edit Credentials dialog rendered an empty body for MCP
// connections (no form branch), so an MCP connection could never have its
// token rotated — and a connection flipped to auth_failed was unrecoverable.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockApiPatch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiPatch: (...args: unknown[]) => mockApiPatch(...args),
  apiPost: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const mcpConnection = {
  id: "conn-mcp-1",
  type: "mcp",
  name: "GitHub",
  description: "",
  credentials: {},
  data: { preset: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/" },
  status: "active",
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cannotDecrypt: false,
} as unknown as IntegrationConnection;

describe("EditCredentialsDialog — MCP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiPatch.mockResolvedValue({});
  });

  it("renders a token field for MCP connections (not an empty dialog)", () => {
    render(
      <EditCredentialsDialog
        connection={mcpConnection}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/token/i)).toHaveAttribute("type", "password");
  });

  it("rotates the token via PATCH credentials.token", async () => {
    const user = userEvent.setup();
    render(
      <EditCredentialsDialog
        connection={mcpConnection}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/token/i), "ghp_fresh_token");
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/api/integrations/conn-mcp-1", {
        credentials: { token: "ghp_fresh_token" },
      });
    });
  });

  it("shows the auth_failed banner for an MCP connection that needs reconnecting", () => {
    render(
      <EditCredentialsDialog
        connection={{ ...mcpConnection, status: "auth_failed" }}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(screen.getByText(/Current credentials failed authentication/i)).toBeInTheDocument();
  });

  it("does not send an empty token — Save stays disabled until a token is entered", async () => {
    render(
      <EditCredentialsDialog
        connection={mcpConnection}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    // mcpEditSchema requires token to be non-empty when present, but the
    // field itself is optional (leave empty = keep current) — Save must stay
    // clickable with an empty field so the user can close without rotating.
    // Submitting with an empty token must NOT call the API with an empty
    // string, since the server's .min(1) would reject it anyway.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/api/integrations/conn-mcp-1", {
        credentials: {},
      });
    });
  });
});
