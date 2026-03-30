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

  describe("database auto-detection", () => {
    it("should fetch databases when URL field loses focus", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/list-databases")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, databases: ["production", "staging"] }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://odoo.example.com");
      await user.tab(); // triggers onBlur

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/integrations/list-databases",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ url: "https://odoo.example.com" }),
          })
        );
      });

      // Should show a select dropdown instead of text input
      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });

    it("should keep text input when database fetch fails", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/list-databases")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: false, error: "Could not list databases" }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

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

      // Should still have a text input for database
      const dbInput = screen.getByLabelText("Database");
      expect(dbInput.tagName).toBe("INPUT");

      fetchSpy.mockRestore();
    });

    it("should pre-fill database from odoo.com subdomain", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/list-databases")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, databases: ["mycompany"] }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://mycompany.odoo.com");
      await user.tab();

      // Should auto-select "mycompany" from the fetched databases
      await waitFor(() => {
        const combobox = screen.getByRole("combobox");
        expect(combobox).toHaveTextContent("mycompany");
      });

      fetchSpy.mockRestore();
    });

    it("should pre-fill database from dev.odoo.com subdomain", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/list-databases")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              databases: ["traun-capital-staging-pinchy-30159487"],
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

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

    it("should show loading state while fetching databases", async () => {
      const user = userEvent.setup();
      let resolveFetch: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation((url) => {
        const urlStr = resolveUrl(url);
        if (urlStr.includes("/api/integrations/list-databases")) {
          return fetchPromise;
        }
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "https://odoo.example.com");
      await user.tab();

      // Database field should be disabled while loading
      await waitFor(() => {
        const dbInput = screen.getByLabelText("Database");
        expect(dbInput).toBeDisabled();
        expect(dbInput).toHaveAttribute("placeholder", "Loading databases...");
      });

      // Resolve the fetch
      resolveFetch!({
        ok: true,
        json: async () => ({ success: true, databases: ["prod"] }),
      } as Response);

      // After loading, should show dropdown
      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fetchSpy.mockRestore();
    });

    it("should not fetch databases when URL is invalid", async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(() => {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      });

      render(<AddIntegrationDialog {...defaultProps} />);
      await selectOdooType(user);

      const urlInput = screen.getByLabelText("URL");
      await user.type(urlInput, "not-a-url");
      await user.tab();

      // Should not have called list-databases
      await waitFor(() => {
        const calls = fetchSpy.mock.calls.filter((call) => {
          const urlStr = resolveUrl(call[0] as string);
          return urlStr.includes("/api/integrations/list-databases");
        });
        expect(calls).toHaveLength(0);
      });

      fetchSpy.mockRestore();
    });
  });
});
