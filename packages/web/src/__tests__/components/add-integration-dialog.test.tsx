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

  describe("Google OAuth type", () => {
    async function selectGoogleType(user: ReturnType<typeof userEvent.setup>) {
      const googleButton = screen.getByText("Google");
      await user.click(googleButton);
    }

    it("should show Google as a type option alongside Odoo", () => {
      render(<AddIntegrationDialog {...defaultProps} />);
      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByText("Google")).toBeInTheDocument();
    });

    it("should show OAuth connect button when Google is selected", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      expect(screen.getByRole("link", { name: /connect google account/i })).toBeInTheDocument();
    });

    it("should link to /api/integrations/oauth/start", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      const link = screen.getByRole("link", { name: /connect google account/i });
      expect(link).toHaveAttribute("href", "/api/integrations/oauth/start");
    });

    it("should show step indicator with 1 of 2 for Google connect step", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
    });

    it("should disable OAuth button and show warning when not on HTTPS", async () => {
      // jsdom defaults to http://localhost, so insecure mode is the default
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      const link = screen.getByRole("link", { name: /connect google account/i });
      expect(link).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText("HTTPS is required for Google OAuth.")).toBeInTheDocument();
    });

    it("should enable OAuth button when on HTTPS", async () => {
      // Temporarily change location.protocol
      const originalProtocol = window.location.protocol;
      Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, protocol: "https:" },
      });

      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      const link = screen.getByRole("link", { name: /connect google account/i });
      expect(link).not.toHaveAttribute("aria-disabled");
      expect(screen.queryByText("HTTPS is required for Google OAuth.")).not.toBeInTheDocument();

      // Restore
      Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, protocol: originalProtocol },
      });
    });

    it("should not show Odoo form fields when Google is selected", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    });

    it("should allow navigating back to type selection from Google connect step", async () => {
      const user = userEvent.setup();
      render(<AddIntegrationDialog {...defaultProps} />);
      await selectGoogleType(user);

      const backButton = screen.getByRole("button", { name: /back/i });
      await user.click(backButton);

      // Should be back on type selection
      expect(screen.getByText("Add Integration")).toBeInTheDocument();
      expect(screen.getByText("Odoo")).toBeInTheDocument();
      expect(screen.getByText("Google")).toBeInTheDocument();
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
