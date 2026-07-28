// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/integrations/odoo-url", () => ({
  normalizeOdooUrl: vi.fn((url: string) => url),
  parseOdooSubdomainHint: vi.fn(() => null),
  generateConnectionName: vi.fn(() => "Test Connection"),
}));

vi.mock("@/lib/integrations/odoo-sync", () => ({
  getAccessibleCategoryLabels: vi.fn(() => []),
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
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

function renderDialog() {
  return render(<AddIntegrationDialog open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
}

async function selectGoogle(user: ReturnType<typeof userEvent.setup>) {
  const googleButton = screen.getByText("Google").closest("button")!;
  await user.click(googleButton);
}

describe("Add Integration Dialog — Google flow", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiPost).mockReset();
  });

  describe("when HTTPS is not available", () => {
    beforeEach(() => {
      vi.stubGlobal("location", { ...window.location, protocol: "http:" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows HTTPS required warning and no connect button", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      expect(screen.getByText(/HTTPS is required/)).toBeInTheDocument();
      expect(screen.queryByText("Connect Google Account")).not.toBeInTheDocument();
    });
  });

  describe("when HTTPS is available but OAuth is not configured", () => {
    beforeEach(() => {
      vi.stubGlobal("location", { ...window.location, protocol: "https:" });
      vi.mocked(apiGet).mockResolvedValue({ configured: false, clientId: "" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows OAuth setup form with redirect URL and credential fields", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByText(/Set up Google OAuth/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
      expect(screen.getByText(/\/api\/integrations\/oauth\/callback/)).toBeInTheDocument();
    });

    it("does not show Connect Google Account button before OAuth is saved", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByText(/Set up Google OAuth/i)).toBeInTheDocument();
      });

      expect(screen.queryByText("Connect Google Account")).not.toBeInTheDocument();
    });

    it("saves OAuth credentials and advances to connect step", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "test-client-id");
      await user.type(screen.getByLabelText("Client Secret"), "test-secret");

      vi.mocked(apiPost).mockResolvedValueOnce({ success: true });

      await user.click(screen.getByRole("button", { name: /Save & Continue/i }));

      await waitFor(() => {
        expect(apiPost).toHaveBeenCalledWith("/api/settings/oauth", {
          provider: "google",
          clientId: "test-client-id",
          clientSecret: "test-secret",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Connect Google Account")).toBeInTheDocument();
      });
    });

    it("shows inline error when OAuth save fails", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "bad-id");
      await user.type(screen.getByLabelText("Client Secret"), "bad-secret");

      vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(400, "Invalid client credentials"));

      await user.click(screen.getByRole("button", { name: /Save & Continue/i }));

      await waitFor(() => {
        expect(screen.getByText("Invalid client credentials")).toBeInTheDocument();
      });

      // Should still be on the OAuth setup form, not advanced to connect
      expect(screen.queryByText("Connect Google Account")).not.toBeInTheDocument();
    });
  });

  describe("when HTTPS is available and OAuth is already configured", () => {
    beforeEach(() => {
      vi.stubGlobal("location", { ...window.location, protocol: "https:" });
      vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "existing-client-id" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("skips OAuth setup and shows Connect Google Account directly", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByText("Connect Google Account")).toBeInTheDocument();
      });

      expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
    });
  });

  describe("Copy redirect URI button", () => {
    let clipboardWriteTextSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.stubGlobal("location", { ...window.location, protocol: "https:" });
      vi.mocked(apiGet).mockResolvedValue({ configured: false, clientId: "" });

      // Mock clipboard API
      clipboardWriteTextSpy = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      clipboardWriteTextSpy.mockRestore();
    });

    it("shows success feedback when copy button is clicked", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectGoogle(user);

      await waitFor(() => {
        expect(screen.getByText(/Set up Google OAuth/i)).toBeInTheDocument();
      });

      const codeElement = screen.getByText(/\/api\/integrations\/oauth\/callback/);
      const copyButton = codeElement.parentElement?.querySelector("button");
      expect(copyButton).toBeInTheDocument();

      // Click to copy
      await user.click(copyButton!);

      // Verify clipboard.writeText was called
      await waitFor(() => {
        expect(clipboardWriteTextSpy).toHaveBeenCalledWith(
          expect.stringContaining("/api/integrations/oauth/callback")
        );
      });

      // After click, button should show checkmark icon
      const checkIcon = copyButton?.querySelector("svg");
      expect(checkIcon?.closest("svg")).toBeInTheDocument();
    });
  });
});
