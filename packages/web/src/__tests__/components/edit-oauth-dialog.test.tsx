import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EditOAuthDialog } from "@/components/edit-oauth-dialog";
import { toast } from "sonner";

let fetchSpy: ReturnType<typeof vi.spyOn>;

describe("EditOAuthDialog", () => {
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("loads and displays current Client ID on open", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "existing-id.apps.googleusercontent.com" }),
    } as Response);

    render(<EditOAuthDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue(
        "existing-id.apps.googleusercontent.com"
      );
    });
  });

  it("shows note that changes apply to all Google connections", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/all Google connections/i)).toBeInTheDocument();
    });
  });

  it("saves updated credentials and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "old-id" }),
    } as Response);

    render(<EditOAuthDialog open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-id");
    });

    await user.clear(screen.getByLabelText("Client ID"));
    await user.type(screen.getByLabelText("Client ID"), "new-id");
    await user.type(screen.getByLabelText("Client Secret"), "new-secret");

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/settings/oauth",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            provider: "google",
            clientId: "new-id",
            clientSecret: "new-secret",
          }),
        })
      );
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Google OAuth settings saved");
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows inline error when save fails", async () => {
    const user = userEvent.setup();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "old-id" }),
    } as Response);

    render(<EditOAuthDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-id");
    });

    await user.type(screen.getByLabelText("Client Secret"), "some-secret");

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid credentials" }),
    } as Response);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("disables save when Client Secret is empty", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });
});
