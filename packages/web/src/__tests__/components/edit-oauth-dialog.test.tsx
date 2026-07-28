// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
  };
});

import { EditOAuthDialog } from "@/components/edit-oauth-dialog";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

describe("EditOAuthDialog", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiPost).mockReset();
  });

  it("loads and displays current Client ID on open", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      configured: true,
      clientId: "existing-id.apps.googleusercontent.com",
    });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue(
        "existing-id.apps.googleusercontent.com"
      );
    });
  });

  it("fetches settings for the given provider", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/api/settings/oauth?provider=google");
    });
  });

  it("shows note that changes apply to all Google integrations", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

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
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText("Update your Google OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });
  });

  it("does not render a Tenant ID field for google", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Tenant ID/i)).not.toBeInTheDocument();
  });

  it("saves updated credentials and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    vi.mocked(apiGet).mockResolvedValueOnce({ configured: true, clientId: "old-id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-id");
    });

    await user.clear(screen.getByLabelText("Client ID"));
    await user.type(screen.getByLabelText("Client ID"), "new-id");
    await user.type(screen.getByLabelText("Client Secret"), "new-secret");

    vi.mocked(apiPost).mockResolvedValueOnce({ success: true });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/settings/oauth", {
        provider: "google",
        clientId: "new-id",
        clientSecret: "new-secret",
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Google OAuth settings saved");
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows inline error when save fails", async () => {
    const user = userEvent.setup();

    vi.mocked(apiGet).mockResolvedValueOnce({ configured: true, clientId: "old-id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-id");
    });

    await user.type(screen.getByLabelText("Client Secret"), "some-secret");

    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(400, "Invalid credentials"));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("enables save when Client ID is filled and Client Secret is left blank", async () => {
    // The secret is optional on edit — an empty field means "keep the
    // current secret", matching edit-credentials-dialog.tsx's pattern.
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
  });

  it("disables save when Client ID is empty", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });

  it("submits without a clientSecret field when the secret is left blank", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    vi.mocked(apiGet).mockResolvedValueOnce({ configured: true, clientId: "old-id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-id");
    });

    await user.clear(screen.getByLabelText("Client ID"));
    await user.type(screen.getByLabelText("Client ID"), "new-id");

    vi.mocked(apiPost).mockResolvedValueOnce({ success: true });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/settings/oauth", {
        provider: "google",
        clientId: "new-id",
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Google OAuth settings saved");
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a hint that the secret field can be left blank to keep the current secret", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "id" });

    render(<EditOAuthDialog provider="google" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client Secret")).toHaveAttribute(
        "placeholder",
        "Leave empty to keep the current secret"
      );
    });
  });
});

describe("EditOAuthDialog — microsoft provider", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiPost).mockReset();
  });

  it("fetches settings for the microsoft provider", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "ms-id", tenantId: "" });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/api/settings/oauth?provider=microsoft");
    });
  });

  it("renders Client ID, Client Secret and Tenant ID fields", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "ms-id", tenantId: "" });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
    expect(screen.getByLabelText(/Tenant ID/i)).toBeInTheDocument();
  });

  it("uses provider-generic copy for microsoft", async () => {
    vi.mocked(apiGet).mockResolvedValue({ configured: true, clientId: "ms-id", tenantId: "" });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText("Update your Microsoft OAuth Client ID and Secret.")
      ).toBeInTheDocument();
    });
  });

  it("prefills the existing tenantId from the GET response", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      configured: true,
      clientId: "ms-id",
      tenantId: "my-tenant",
    });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Tenant ID/i)).toHaveValue("my-tenant");
    });
  });

  it("posts microsoft-shaped body including tenantId", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    vi.mocked(apiGet).mockResolvedValueOnce({
      configured: true,
      clientId: "old-ms-id",
      tenantId: "old-tenant",
    });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-ms-id");
    });

    await user.clear(screen.getByLabelText("Client ID"));
    await user.type(screen.getByLabelText("Client ID"), "new-ms-id");
    await user.type(screen.getByLabelText("Client Secret"), "new-ms-secret");
    await user.clear(screen.getByLabelText(/Tenant ID/i));
    await user.type(screen.getByLabelText(/Tenant ID/i), "new-tenant");

    vi.mocked(apiPost).mockResolvedValueOnce({ success: true });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/settings/oauth", {
        provider: "microsoft",
        clientId: "new-ms-id",
        clientSecret: "new-ms-secret",
        tenantId: "new-tenant",
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Microsoft OAuth settings saved");
    });
  });

  it("omits tenantId from the POST body when left blank", async () => {
    const user = userEvent.setup();

    vi.mocked(apiGet).mockResolvedValueOnce({
      configured: true,
      clientId: "old-ms-id",
      tenantId: "",
    });

    render(<EditOAuthDialog provider="microsoft" open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Client ID")).toHaveValue("old-ms-id");
    });

    await user.type(screen.getByLabelText("Client Secret"), "new-ms-secret");

    vi.mocked(apiPost).mockResolvedValueOnce({ success: true });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/settings/oauth", {
        provider: "microsoft",
        clientId: "old-ms-id",
        clientSecret: "new-ms-secret",
      });
    });
  });
});
