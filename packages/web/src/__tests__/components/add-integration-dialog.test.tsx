import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AddIntegrationDialog } from "@/components/add-integration-dialog";

// Mock sonner
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function resolveUrl(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
}

function mockListDatabases(databases: string[], success = true) {
  return vi.spyOn(global, "fetch").mockImplementation((url) => {
    const urlStr = resolveUrl(url);
    if (urlStr.includes("/api/integrations/list-databases")) {
      return Promise.resolve({
        ok: true,
        json: async () => (success ? { success: true, databases } : { success: false }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

describe("AddIntegrationDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function selectOdooType(user: ReturnType<typeof userEvent.setup>) {
    const odooButton = screen.getByText("Odoo");
    await user.click(odooButton);
  }

  describe("database field visibility", () => {
    it("should NOT show database field before URL is entered", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();
    });

    it("should hide database field when exactly one database is found (auto-set)", async () => {
      const user = userEvent.setup();
      const fetchSpy = mockListDatabases(["production"]);

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://odoo.example.com");
      await user.tab();

      // Wait for fetch to complete
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/integrations/list-databases",
          expect.anything()
        );
      });

      // Database field should still be hidden (auto-set in background)
      await waitFor(() => {
        expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });

    it("should show dropdown when multiple databases are found", async () => {
      const user = userEvent.setup();
      const fetchSpy = mockListDatabases(["production", "staging"]);

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://odoo.example.com");
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });

    it("should show text input when database fetch fails", async () => {
      const user = userEvent.setup();
      const fetchSpy = mockListDatabases([], false);

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://odoo.example.com");
      await user.tab();

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/integrations/list-databases",
          expect.anything()
        );
      });

      // Should show text input as fallback
      await waitFor(() => {
        const dbInput = screen.getByLabelText("Database");
        expect(dbInput.tagName).toBe("INPUT");
      });

      fetchSpy.mockRestore();
    });

    it("should not show database field when URL is invalid", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(() => {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "not-a-url");
      await user.tab();

      expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();

      fetchSpy.mockRestore();
    });
  });

  describe("Pipedrive wizard flow", () => {
    async function selectPipedriveType(user: ReturnType<typeof userEvent.setup>) {
      const pipedriveButton = screen.getByText("Pipedrive");
      await user.click(pipedriveButton);
    }

    it("should show Pipedrive in type selection", () => {
      render(<AddIntegrationDialog {...defaultProps} />);

      expect(screen.getByText("Pipedrive")).toBeInTheDocument();
      expect(
        screen.getByText("Connect your Pipedrive CRM to manage deals, contacts, and pipeline data.")
      ).toBeInTheDocument();
    });

    it("should show API Token field when Pipedrive is selected (not URL/login/apiKey/db)", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectPipedriveType(user);

      expect(screen.getByLabelText("API Token")).toBeInTheDocument();
      expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();
    });

    it("should go back to type selection from Pipedrive connect step", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectPipedriveType(user);

      // Should be on connect step
      expect(screen.getByText("Connect Pipedrive")).toBeInTheDocument();

      const backButton = screen.getByText("Back");
      await user.click(backButton);

      // Should be back on type selection
      expect(screen.getByText("Add Integration")).toBeInTheDocument();
      expect(screen.getByText("Pipedrive")).toBeInTheDocument();
      expect(screen.getByText("Odoo")).toBeInTheDocument();
    });

    it("should show sync step after successful Pipedrive connection", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url, init) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/test-credentials")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              companyDomain: "mycompany",
              companyName: "My Company Ltd",
              userId: 42,
              userName: "Jane Doe",
            }),
          } as Response);
        }
        if (urlStr.includes("/api/integrations/sync-preview")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              entities: 10,
              categories: [
                {
                  id: "crm",
                  label: "CRM",
                  accessible: true,
                  accessibleEntities: ["Deals", "Persons"],
                  totalEntities: 5,
                },
              ],
              data: { entities: [], lastSyncAt: "2026-04-13T12:00:00.000Z" },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectPipedriveType(user);

      const apiTokenInput = screen.getByLabelText("API Token");
      await user.type(apiTokenInput, "pd-test-token");

      const connectButton = screen.getByRole("button", { name: "Connect" });
      await user.click(connectButton);

      // Should reach sync step with Pipedrive-specific loading text
      await waitFor(() => {
        // After sync completes, categories should show
        expect(screen.getByText("CRM")).toBeInTheDocument();
        expect(screen.getByText("Deals, Persons")).toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });

    it("should show inline error on Pipedrive connection failure", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/test-credentials")) {
          return Promise.resolve({
            ok: false,
            json: async () => ({
              success: false,
              error: "Invalid API token",
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectPipedriveType(user);

      const apiTokenInput = screen.getByLabelText("API Token");
      await user.type(apiTokenInput, "bad-token");

      const connectButton = screen.getByRole("button", { name: "Connect" });
      await user.click(connectButton);

      await waitFor(() => {
        expect(screen.getByText("Invalid API token")).toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });
  });

  describe("database auto-selection", () => {
    it("should pre-select database matching odoo.com subdomain", async () => {
      const user = userEvent.setup();
      const fetchSpy = mockListDatabases(["mycompany", "staging"]);

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://mycompany.odoo.com");
      await user.tab();

      await waitFor(() => {
        const combobox = screen.getByRole("combobox");
        expect(combobox).toHaveTextContent("mycompany");
      });

      fetchSpy.mockRestore();
    });

    it("should pre-select database matching dev.odoo.com subdomain", async () => {
      const user = userEvent.setup();
      const fetchSpy = mockListDatabases(["traun-capital-staging-pinchy-30159487", "other"]);

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://traun-capital-staging-pinchy-30159487.dev.odoo.com");
      await user.tab();

      await waitFor(() => {
        const combobox = screen.getByRole("combobox");
        expect(combobox).toHaveTextContent("traun-capital-staging-pinchy-30159487");
      });

      fetchSpy.mockRestore();
    });
  });
});
