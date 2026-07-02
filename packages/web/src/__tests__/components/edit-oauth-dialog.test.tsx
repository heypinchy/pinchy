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

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue(
        "existing-id.apps.googleusercontent.com"
      );
    });
  });

  it("fetches settings for the given provider", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/oauth?provider=google");
    });
  });

  it("shows note that changes apply to all Google integrations", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      // Provider-level copy says "integrations", not "mailboxes": the OAuth app
      // will soon back more than mail (calendar, drive, ...), so app-level
      // wording must not name a single service. "Mailbox" stays reserved for
      // email-domain copy (email templates, the mailbox picker).
      expect(screen.getByText(/all Google integrations/i)).toBeInTheDocument();
    });
  });

  it("uses provider-generic copy in the description", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText("Update your Google OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });
  });

  it("does not render a Tenant ID field for google", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "id" }),
    } as Response);

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Tenant ID/i)).not.toBeInTheDocument();
  });

  it("saves updated credentials and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "old-id" }),
    } as Response);

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={onOpenChange} />);

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

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

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

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });
});

describe("EditOAuthDialog — microsoft provider", () => {
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches settings for the microsoft provider", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "ms-id", tenantId: "" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/oauth?provider=microsoft");
    });
  });

  it("renders Client ID, Client Secret and Tenant ID fields", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "ms-id", tenantId: "" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
    expect(screen.getByLabelText(/Tenant ID/i)).toBeInTheDocument();
  });

  it("uses provider-generic copy for microsoft", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "ms-id", tenantId: "" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText("Update your Microsoft OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });
  });

  it("prefills the existing tenantId from the GET response", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true, clientId: "ms-id", tenantId: "my-tenant" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Tenant ID/i)).toHaveValue("my-tenant");
    });
  });

  it("posts microsoft-shaped body including tenantId", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "old-ms-id", tenantId: "old-tenant" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-ms-id");
    });

    await user.clear(screen.getByLabelText("Client ID"));
    await user.type(screen.getByLabelText("Client ID"), "new-ms-id");
    await user.type(screen.getByLabelText("Client Secret"), "new-ms-secret");
    await user.clear(screen.getByLabelText(/Tenant ID/i));
    await user.type(screen.getByLabelText(/Tenant ID/i), "new-tenant");

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
            provider: "microsoft",
            clientId: "new-ms-id",
            clientSecret: "new-ms-secret",
            tenantId: "new-tenant",
          }),
        })
      );
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Microsoft OAuth settings saved");
    });
  });

  it("omits tenantId from the POST body when left blank", async () => {
    const user = userEvent.setup();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, clientId: "old-ms-id", tenantId: "" }),
    } as Response);

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-ms-id");
    });

    await user.type(screen.getByLabelText("Client Secret"), "new-ms-secret");

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
            provider: "microsoft",
            clientId: "old-ms-id",
            clientSecret: "new-ms-secret",
          }),
        })
      );
    });
  });
});
