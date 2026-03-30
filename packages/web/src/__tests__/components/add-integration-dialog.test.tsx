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
