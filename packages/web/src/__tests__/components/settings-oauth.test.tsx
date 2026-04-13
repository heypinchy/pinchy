import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsOAuth } from "@/components/settings-oauth";

describe("SettingsOAuth", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders Google OAuth heading", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    expect(screen.getByText("OAuth Providers")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
  });

  it("loads existing settings on mount", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        configured: true,
        clientId: "my-client-id.apps.googleusercontent.com",
      }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/oauth?provider=google");
    });

    await waitFor(() => {
      const clientIdInput = screen.getByLabelText("Client ID");
      expect(clientIdInput).toHaveValue("my-client-id.apps.googleusercontent.com");
    });
  });

  it("shows masked placeholder for Client Secret when already configured", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        configured: true,
        clientId: "my-client-id.apps.googleusercontent.com",
      }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      const secretInput = screen.getByLabelText("Client Secret");
      expect(secretInput).toHaveAttribute("placeholder", expect.stringContaining("configured"));
    });
  });

  it("shows empty fields when no settings exist", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      const clientIdInput = screen.getByLabelText("Client ID");
      expect(clientIdInput).toHaveValue("");
    });
  });

  it("saves settings when form is submitted", async () => {
    const user = userEvent.setup();

    // First call: GET to load settings
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Client ID"), "new-client-id");
    await user.type(screen.getByLabelText("Client Secret"), "new-client-secret");

    // POST to save + GET to reload
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        configured: true,
        clientId: "new-client-id",
      }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          clientId: "new-client-id",
          clientSecret: "new-client-secret",
        }),
      });
    });
  });

  it("disables save button when fields are empty", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });

  it("enables save button when both fields have values", async () => {
    const user = userEvent.setup();

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Client ID"), "some-id");
    await user.type(screen.getByLabelText("Client Secret"), "some-secret");

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows success toast after saving", async () => {
    const user = userEvent.setup();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client Secret"), "secret");

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Save" }));

    // The component should show a configured indicator after save
    await waitFor(() => {
      expect(screen.getByTestId("oauth-configured-indicator")).toBeInTheDocument();
    });
  });

  it("shows error when save fails", async () => {
    const user = userEvent.setup();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client Secret"), "secret");

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Something went wrong" }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });

  it("shows Client Secret as password type input", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false, clientId: "" }),
    } as Response);

    render(<SettingsOAuth />);

    await waitFor(() => {
      const secretInput = screen.getByLabelText("Client Secret");
      expect(secretInput).toHaveAttribute("type", "password");
    });
  });
});
