import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/integrations/odoo-url", () => ({
  normalizeOdooUrl: vi.fn((url: string) => url),
  parseOdooSubdomainHint: vi.fn(() => null),
  generateConnectionName: vi.fn(() => "Test Connection"),
}));

import { AddIntegrationDialog } from "@/components/add-integration-dialog";

let fetchSpy: ReturnType<typeof vi.spyOn>;

function renderDialog() {
  return render(<AddIntegrationDialog open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
}

async function selectMicrosoft(user: ReturnType<typeof userEvent.setup>) {
  const microsoftButton = screen.getByText("Microsoft").closest("button")!;
  await user.click(microsoftButton);
}

describe("Add Integration Dialog — Microsoft flow", () => {
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.stubGlobal("location", { ...window.location, protocol: "https:" });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  describe("Microsoft step: shows OAuth setup form when not configured", () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ configured: false }),
      } as Response);
    });

    it("shows OAuth setup form with Client ID and Client Secret fields", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
    });

    it("shows the redirect URI pointing to /api/integrations/oauth/callback", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByText(/\/api\/integrations\/oauth\/callback/)).toBeInTheDocument();
      });
    });

    it("shows a Copy redirect URI button", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByText(/\/api\/integrations\/oauth\/callback/)).toBeInTheDocument();
      });

      const codeElement = screen.getByText(/\/api\/integrations\/oauth\/callback/);
      const copyButton = codeElement.parentElement?.querySelector("button");
      expect(copyButton).toBeInTheDocument();
    });

    it("shows a link to Azure Portal or setup instructions", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByRole("link", { name: /Azure Portal/i })).toBeInTheDocument();
      });
    });
  });

  describe("Microsoft step: tenant ID is optional with helper text", () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ configured: false }),
      } as Response);
    });

    it("shows Tenant ID field", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Tenant ID")).toBeInTheDocument();
      });
    });

    it("shows helper text indicating Tenant ID is optional", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(
          screen.getByText(/Optional.*leave blank.*work.*school account/i)
        ).toBeInTheDocument();
      });
    });

    it("Save & Continue button is enabled without Tenant ID filled in", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "some-client-id");
      await user.type(screen.getByLabelText("Client Secret"), "some-client-secret");
      // Intentionally leave Tenant ID blank

      const saveButton = screen.getByRole("button", { name: /Save & Continue/i });
      expect(saveButton).not.toBeDisabled();
    });
  });

  describe("Microsoft step: Connect button links to /api/integrations/oauth/start?provider=microsoft", () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ configured: true }),
      } as Response);
    });

    it("shows Connect Microsoft Account link when OAuth is configured", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /connect microsoft account/i })
        ).toBeInTheDocument();
      });
    });

    it("Connect Microsoft Account link points to /api/integrations/oauth/start?provider=microsoft", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        const link = screen.getByRole("link", { name: /connect microsoft account/i });
        expect(link).toHaveAttribute("href", "/api/integrations/oauth/start?provider=microsoft");
      });
    });

    it("does not show setup form fields when already configured", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /connect microsoft account/i })
        ).toBeInTheDocument();
      });

      expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Client Secret")).not.toBeInTheDocument();
    });
  });

  describe("Microsoft step: save OAuth credentials flow", () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ configured: false }),
      } as Response);
    });

    it("POSTs to /api/settings/oauth with provider=microsoft, clientId, clientSecret, tenantId", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "my-client-id");
      await user.type(screen.getByLabelText("Client Secret"), "my-client-secret");
      await user.type(screen.getByLabelText("Tenant ID"), "my-tenant-id");

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      await user.click(screen.getByRole("button", { name: /Save & Continue/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/settings/oauth",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"provider":"microsoft"'),
          })
        );
      });

      const callBody = JSON.parse(
        (
          fetchSpy.mock.calls.find(
            (c) => c[0] === "/api/settings/oauth" && (c[1] as RequestInit)?.method === "POST"
          )?.[1] as RequestInit
        )?.body as string
      );
      expect(callBody.clientId).toBe("my-client-id");
      expect(callBody.clientSecret).toBe("my-client-secret");
      expect(callBody.tenantId).toBe("my-tenant-id");
    });

    it("shows Connect Microsoft Account after saving credentials", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "test-client-id");
      await user.type(screen.getByLabelText("Client Secret"), "test-secret");

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      await user.click(screen.getByRole("button", { name: /Save & Continue/i }));

      await waitFor(() => {
        expect(screen.getByText("Connect Microsoft Account")).toBeInTheDocument();
      });
    });

    it("shows inline error when save fails", async () => {
      const user = userEvent.setup();
      renderDialog();
      await selectMicrosoft(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Client ID"), "bad-id");
      await user.type(screen.getByLabelText("Client Secret"), "bad-secret");

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Invalid Microsoft credentials" }),
      } as Response);

      await user.click(screen.getByRole("button", { name: /Save & Continue/i }));

      await waitFor(() => {
        expect(screen.getByText("Invalid Microsoft credentials")).toBeInTheDocument();
      });

      expect(screen.queryByText("Connect Microsoft Account")).not.toBeInTheDocument();
    });
  });
});
