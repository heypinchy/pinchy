import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { EditCredentialsDialog } from "@/components/edit-credentials-dialog";
import type { IntegrationConnection } from "@/lib/integrations/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiPatch: vi.fn(),
    apiPost: vi.fn(),
  };
});

import { apiPatch, apiPost } from "@/lib/api-client";

const odooConnection: IntegrationConnection = {
  id: "conn-odoo-1",
  type: "odoo",
  name: "Production ERP",
  description: "",
  credentials: { url: "https://odoo.example.com", db: "prod", login: "admin" },
  data: null,
  status: "active",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const authFailedOdooConnection: IntegrationConnection = {
  ...odooConnection,
  id: "conn-odoo-2",
  name: "Staging ERP",
  status: "auth_failed",
  lastError: "401 from Odoo",
};

const webSearchConnection: IntegrationConnection = {
  id: "conn-ws-1",
  type: "web-search",
  name: "Brave Search",
  description: "",
  credentials: "configured",
  data: null,
  status: "active",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const googleConnection: IntegrationConnection = {
  id: "conn-google-1",
  type: "google",
  name: "Google Workspace",
  description: "",
  credentials: null,
  data: { provider: "google" },
  status: "active",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

const microsoftConnection: IntegrationConnection = {
  id: "conn-microsoft-1",
  type: "microsoft",
  name: "user@outlook.com",
  description: "",
  credentials: null,
  data: { provider: "microsoft" },
  status: "auth_failed",
  lastError: "401 from Microsoft",
  lastErrorAt: null,
  createdAt: "2026-04-13T12:00:00Z",
  updatedAt: "2026-04-13T12:00:00Z",
  cannotDecrypt: false,
};

describe("EditCredentialsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Odoo integration", () => {
    it("renders the dialog with fields pre-filled from connection data", async () => {
      render(
        <EditCredentialsDialog
          connection={odooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByLabelText("URL")).toHaveValue("https://odoo.example.com");
      expect(screen.getByLabelText("Database")).toHaveValue("prod");
      expect(screen.getByLabelText("Login")).toHaveValue("admin");
      expect(screen.getByLabelText("API Key")).toHaveValue("");
    });

    it("sends PATCH with only non-empty fields — empty fields are omitted", async () => {
      const user = userEvent.setup();
      vi.mocked(apiPatch).mockResolvedValue({ id: "conn-odoo-1" });

      render(
        <EditCredentialsDialog
          connection={odooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      // Clear pre-filled db and login so they are empty (user wants to keep them via server merge)
      await user.clear(screen.getByLabelText("Database"));
      await user.clear(screen.getByLabelText("Login"));
      await user.type(screen.getByLabelText("API Key"), "new-api-key");

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(apiPatch).toHaveBeenCalled();
      });

      const callArg = vi.mocked(apiPatch).mock.calls[0][1] as {
        credentials: Record<string, string>;
      };
      // Empty db and login should not be sent — server will keep existing values
      expect(callArg.credentials).not.toHaveProperty("db");
      expect(callArg.credentials).not.toHaveProperty("login");
      expect(callArg.credentials).toHaveProperty("apiKey", "new-api-key");
    });

    it("shows success toast and calls onSuccess on save", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      vi.mocked(apiPatch).mockResolvedValue({ id: "conn-odoo-1" });

      render(
        <EditCredentialsDialog
          connection={odooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={onSuccess}
        />
      );

      await user.type(screen.getByLabelText("API Key"), "some-key");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Credentials updated");
      });
      expect(onSuccess).toHaveBeenCalled();
    });

    it("shows inline error from server 400 and keeps dialog open", async () => {
      const user = userEvent.setup();
      vi.mocked(apiPatch).mockRejectedValue(new ApiError(400, "Connection refused by Odoo"));

      render(
        <EditCredentialsDialog
          connection={odooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      await user.type(screen.getByLabelText("API Key"), "bad-key");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(screen.getByText("Connection refused by Odoo")).toBeInTheDocument();
      });

      expect(toast.success).not.toHaveBeenCalled();
    });

    it("shows 'Current credentials failed authentication' hint when status is auth_failed", () => {
      render(
        <EditCredentialsDialog
          connection={authFailedOdooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByText(/Current credentials failed authentication/i)).toBeInTheDocument();
    });

    it("does not show auth_failed hint for active connections", () => {
      render(
        <EditCredentialsDialog
          connection={odooConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(
        screen.queryByText(/Current credentials failed authentication/i)
      ).not.toBeInTheDocument();
    });
  });

  describe("Web Search integration", () => {
    it("renders only the API Key field for web-search", () => {
      render(
        <EditCredentialsDialog
          connection={webSearchConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByLabelText("API Key")).toBeInTheDocument();
      expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();
    });

    it("sends PATCH with apiKey when provided", async () => {
      const user = userEvent.setup();
      vi.mocked(apiPatch).mockResolvedValue({ id: "conn-ws-1" });

      render(
        <EditCredentialsDialog
          connection={webSearchConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      await user.type(screen.getByLabelText("API Key"), "new-brave-key");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(apiPatch).toHaveBeenCalledWith("/api/integrations/conn-ws-1", {
          credentials: { apiKey: "new-brave-key" },
        });
      });
    });
  });

  describe("Google integration", () => {
    it("shows 'Reconnect via Google' button instead of credential fields", () => {
      render(
        <EditCredentialsDialog
          connection={googleConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: "Reconnect via Google" })).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    });

    it("calls apiPost with reconnectConnectionId when 'Reconnect via Google' is clicked", async () => {
      const user = userEvent.setup();
      // Mock location assign
      const assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, assign: assignMock },
        writable: true,
      });
      vi.mocked(apiPost).mockResolvedValue({
        url: "https://accounts.google.com/oauth?code=xxx",
      });

      render(
        <EditCredentialsDialog
          connection={googleConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Reconnect via Google" }));

      await waitFor(() => {
        expect(apiPost).toHaveBeenCalledWith("/api/integrations/oauth/start", {
          reconnectConnectionId: "conn-google-1",
        });
      });

      await waitFor(() => {
        expect(assignMock).toHaveBeenCalledWith("https://accounts.google.com/oauth?code=xxx");
      });
    });
  });

  describe("Microsoft integration", () => {
    it("shows 'Reconnect via Microsoft' button instead of credential fields", () => {
      render(
        <EditCredentialsDialog
          connection={microsoftConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: "Reconnect via Microsoft" })).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    });

    it("calls apiPost with reconnectConnectionId when 'Reconnect via Microsoft' is clicked", async () => {
      const user = userEvent.setup();
      const assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, assign: assignMock },
        writable: true,
      });
      vi.mocked(apiPost).mockResolvedValue({
        url: "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize?code=xxx",
      });

      render(
        <EditCredentialsDialog
          connection={microsoftConnection}
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Reconnect via Microsoft" }));

      await waitFor(() => {
        expect(apiPost).toHaveBeenCalledWith("/api/integrations/oauth/start", {
          reconnectConnectionId: "conn-microsoft-1",
        });
      });

      await waitFor(() => {
        expect(assignMock).toHaveBeenCalledWith(
          "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize?code=xxx"
        );
      });
    });
  });

  it("does not render form content when connection is null (open=true)", () => {
    render(
      <EditCredentialsDialog
        connection={null}
        open={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    // Dialog is open but connection is null — no form fields should appear
    expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect via Google" })).not.toBeInTheDocument();
  });

  it("sends PATCH with empty credentials object when all Odoo fields are left empty", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPatch).mockResolvedValue({ id: "conn-odoo-1" });

    render(
      <EditCredentialsDialog
        connection={odooConnection}
        open={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    // Clear all pre-filled fields so all are empty
    await user.clear(screen.getByLabelText("URL"));
    await user.clear(screen.getByLabelText("Database"));
    await user.clear(screen.getByLabelText("Login"));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalled();
    });

    const callArg = vi.mocked(apiPatch).mock.calls[0][1] as {
      credentials: Record<string, string>;
    };
    // All empty — no credential fields should be sent; server keeps existing values
    expect(callArg.credentials).toEqual({});
  });
});
