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

import { ImapConnectStep } from "@/components/imap-connect-step";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

function renderStep(props?: Partial<React.ComponentProps<typeof ImapConnectStep>>) {
  const onSuccess = vi.fn();
  const onCancel = vi.fn();
  const utils = render(<ImapConnectStep onSuccess={onSuccess} onCancel={onCancel} {...props} />);
  return { ...utils, onSuccess, onCancel };
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^name$/i), "Work email (IMAP)");
  await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
  await user.tab(); // blur triggers autodiscover, which also prefills username
  await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
  await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
  await user.type(screen.getByLabelText(/^password$/i), "app-password");
}

describe("ImapConnectStep", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    // Default autodiscover response for tests that don't care about prefill —
    // they fill the fields via user.type anyway, so an empty config is fine.
    vi.mocked(apiGet).mockResolvedValue({ config: {}, source: "none" });
    vi.mocked(apiPost).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("renders all fields with port defaults 993/587 and security default TLS", () => {
    renderStep();

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^imap host$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^imap port$/i)).toHaveValue("993");
    expect(screen.getByLabelText(/^smtp host$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^smtp port$/i)).toHaveValue("587");
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByText("TLS")).toBeInTheDocument();
  });

  it("prefills host/port fields from autodiscover on email blur without overwriting user edits", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.gmail.com",
        imapPort: 993,
        smtpHost: "smtp.gmail.com",
        smtpPort: 587,
        security: "tls",
      },
      source: "provider-table",
    });

    const user = userEvent.setup();
    renderStep();

    // User already typed a custom SMTP host before providing their email.
    await user.type(screen.getByLabelText(/^smtp host$/i), "custom-smtp.example.com");

    await user.type(screen.getByLabelText(/email address/i), "someone@gmail.com");
    await user.tab();

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        "/api/integrations/imap/autodiscover?email=someone%40gmail.com"
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("imap.gmail.com");
    });

    // Untouched field gets prefilled...
    expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("imap.gmail.com");
    // ...but the field the user already edited is left alone.
    expect(screen.getByLabelText(/^smtp host$/i)).toHaveValue("custom-smtp.example.com");
    // Username defaults to the email when empty.
    expect(screen.getByLabelText(/^username$/i)).toHaveValue("someone@gmail.com");
  });

  it("does not block the user when autodiscover fails", async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError(500, "boom"));

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
    await user.tab();

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalled();
    });

    // Host fields remain empty, but nothing crashes / no error is shown.
    expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("");
  });

  it("enables Save after a successful Test connection", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    renderStep();
    await fillValidForm(user);

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
    });

    expect(apiPost).toHaveBeenCalledWith(
      "/api/integrations/imap/test",
      expect.objectContaining({
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        username: "someone@example.com",
        password: "app-password",
        security: "tls",
      })
    );
  });

  it("shows an inline error and keeps Save disabled when the test fails with ok:false", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: false, error: "Authentication failed" });

    const user = userEvent.setup();
    renderStep();
    await fillValidForm(user);

    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("shows an inline error when Test connection throws an ApiError", async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(400, "Could not connect to the server"));

    const user = userEvent.setup();
    renderStep();
    await fillValidForm(user);

    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText("Could not connect to the server")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("Save calls the create endpoint with the right body and fires onSuccess + toast after a successful test", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true }); // test
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-1", name: "Work email (IMAP)" }); // create

    const user = userEvent.setup();
    const { onSuccess } = renderStep();
    await fillValidForm(user);

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/api/integrations/imap",
        expect.objectContaining({
          name: "Work email (IMAP)",
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          username: "someone@example.com",
          password: "app-password",
          security: "tls",
        })
      );
    });

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("surfaces a Save ApiError to the user without calling onSuccess", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true }); // test
    vi.mocked(apiPost).mockRejectedValueOnce(
      new ApiError(500, "Could not create the IMAP connection")
    ); // create

    const user = userEvent.setup();
    const { onSuccess } = renderStep();
    await fillValidForm(user);

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText("Could not create the IMAP connection")).toBeInTheDocument();
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });
});
