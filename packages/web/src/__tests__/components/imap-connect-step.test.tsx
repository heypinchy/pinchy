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

async function fillEmailAndPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
  await user.tab(); // blur triggers autodiscover
  await user.type(screen.getByLabelText(/^password$/i), "app-password");
}

describe("ImapConnectStep", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    // Default autodiscover response for tests that don't care about prefill.
    vi.mocked(apiGet).mockResolvedValue({ config: {}, source: "none" });
    vi.mocked(apiPost).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("renders the always-visible fields: Your name, Email address, Password", () => {
    renderStep();

    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(
      screen.getByText(/shown to recipients when this mailbox sends email/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/app password or account password/i)).toBeInTheDocument();
  });

  it("does not render a Name field for the integration label", () => {
    renderStep();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it("has the server settings grid expanded with empty values before any autodiscover", () => {
    renderStep();

    expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^imap port$/i)).toHaveValue("993");
    expect(screen.getByLabelText(/^smtp host$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^smtp port$/i)).toHaveValue("587");
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();
  });

  it("security select only offers Automatic (TLS) and None (insecure)", async () => {
    const user = userEvent.setup();
    renderStep();

    // The trigger shows the current value ("Automatic (TLS)" is the default).
    expect(screen.getByRole("combobox")).toHaveTextContent("Automatic (TLS)");

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "Automatic (TLS)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "None (insecure)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "STARTTLS" })).not.toBeInTheDocument();
  });

  it("collapses into a read-only summary when autodiscover hits the provider table", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.migadu.com",
        imapPort: 993,
        smtpHost: "smtp.migadu.com",
        smtpPort: 465,
        security: "tls",
      },
      source: "provider-table",
    });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@migadu.com");
    await user.tab();

    await waitFor(() => {
      expect(
        screen.getByText(
          "Server settings found — IMAP imap.migadu.com:993 · SMTP smtp.migadu.com:465"
        )
      ).toBeInTheDocument();
    });

    // The full grid is hidden behind the summary.
    expect(screen.queryByLabelText(/^imap host$/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit server settings/i })).toBeInTheDocument();
  });

  it("collapses into a summary when autodiscover hits a DNS SRV record", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.dns-found.example.com",
        imapPort: 993,
        smtpHost: "smtp.dns-found.example.com",
        smtpPort: 465,
        security: "tls",
      },
      source: "dns-srv",
    });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@dns-found.example.com");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText(/server settings found/i)).toBeInTheDocument();
    });
  });

  it("expands the grid with a caution line when autodiscover only produces a guess", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.unknown.example.com",
        imapPort: 993,
        smtpHost: "smtp.unknown.example.com",
        smtpPort: 587,
        security: "tls",
      },
      source: "guess",
    });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@unknown.example.com");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("imap.unknown.example.com");
    });

    expect(
      screen.getByText(/we couldn.t find your provider.s settings, so these are a best guess/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();
  });

  it("keeps the grid expanded when autodiscover finds nothing (source: none)", async () => {
    vi.mocked(apiGet).mockResolvedValue({ config: {}, source: "none" });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
    await user.tab();

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalled();
    });

    expect(screen.getByLabelText(/^imap host$/i)).toBeInTheDocument();
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();
  });

  it("expands the grid via 'Edit server settings' and never re-collapses", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.migadu.com",
        imapPort: 993,
        smtpHost: "smtp.migadu.com",
        smtpPort: 465,
        security: "tls",
      },
      source: "provider-table",
    });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@migadu.com");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /edit server settings/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /edit server settings/i }));

    expect(screen.getByLabelText(/^imap host$/i)).toHaveValue("imap.migadu.com");
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();

    // Editing a field, then re-blurring email (re-running autodiscover with
    // the same provider-table result) must not collapse the grid again.
    await user.clear(screen.getByLabelText(/^smtp port$/i));
    await user.type(screen.getByLabelText(/^smtp port$/i), "9999");
    await user.click(screen.getByLabelText(/email address/i));
    await user.tab();

    expect(screen.getByLabelText(/^imap host$/i)).toBeInTheDocument();
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();
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

  it("username defaults to the email address and stays in sync until the user edits it", async () => {
    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
    await waitFor(() => {
      expect(screen.getByLabelText(/^username$/i)).toHaveValue("someone@example.com");
    });

    await user.type(screen.getByLabelText(/email address/i), ".org");
    await waitFor(() => {
      expect(screen.getByLabelText(/^username$/i)).toHaveValue("someone@example.com.org");
    });

    // Once the user edits the username directly, it stops tracking the email.
    const usernameInput = screen.getByLabelText(/^username$/i);
    await user.click(usernameInput);
    await user.clear(usernameInput);
    await user.type(usernameInput, "custom-user");

    await user.type(screen.getByLabelText(/email address/i), "z");
    expect(screen.getByLabelText(/^username$/i)).toHaveValue("custom-user");
  });

  it("Test & Save is disabled until both email and password are filled", async () => {
    const user = userEvent.setup();
    renderStep();

    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/email address/i), "someone@example.com");
    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/^password$/i), "app-password");
    expect(screen.getByRole("button", { name: /test & save/i })).not.toBeDisabled();
  });

  it("Test & Save runs the test then creates the connection without name, with senderName", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true }); // test
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-1", name: "someone@example.com" }); // create

    const user = userEvent.setup();
    const { onSuccess } = renderStep();

    await user.type(screen.getByLabelText(/your name/i), "Clemens Helm");
    await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
    await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
    await fillEmailAndPassword(user);

    await user.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenNthCalledWith(
        1,
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

    await waitFor(() => {
      expect(apiPost).toHaveBeenNthCalledWith(
        2,
        "/api/integrations/imap",
        expect.objectContaining({
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          username: "someone@example.com",
          password: "app-password",
          senderName: "Clemens Helm",
        })
      );
    });

    const createBody = vi.mocked(apiPost).mock.calls[1][1] as Record<string, unknown>;
    expect(createBody).not.toHaveProperty("name");

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith({ id: "conn-1", name: "someone@example.com" });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("omits senderName from the create body when 'Your name' is left empty", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true }); // test
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "conn-1", name: "someone@example.com" }); // create

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
    await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
    await fillEmailAndPassword(user);

    await user.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(2);
    });

    const createBody = vi.mocked(apiPost).mock.calls[1][1] as Record<string, unknown>;
    expect(createBody).not.toHaveProperty("senderName");
    expect(createBody).not.toHaveProperty("name");
  });

  it("shows Testing… then Saving… while the Test & Save flow is in flight", async () => {
    let resolveTest: (value: { ok: boolean }) => void = () => {};
    let resolveCreate: (value: { id: string; name: string }) => void = () => {};
    vi.mocked(apiPost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve;
        })
    );
    vi.mocked(apiPost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
    await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
    await fillEmailAndPassword(user);

    await user.click(screen.getByRole("button", { name: /test & save/i }));

    expect(screen.getByRole("button", { name: /testing/i })).toBeDisabled();

    resolveTest({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /saving/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    resolveCreate({ id: "conn-1", name: "someone@example.com" });
  });

  it("on test failure (ok:false) shows an inline error near the grid and expands it if collapsed", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      config: {
        imapHost: "imap.migadu.com",
        imapPort: 993,
        smtpHost: "smtp.migadu.com",
        smtpPort: 465,
        security: "tls",
      },
      source: "provider-table",
    });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: false, error: "Authentication failed" });

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/email address/i), "someone@migadu.com");
    await user.tab();
    await waitFor(() => {
      expect(screen.getByText(/server settings found/i)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/^password$/i), "wrong-password");
    await user.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => {
      expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    });

    // The grid expanded to show the error next to the fields.
    expect(screen.queryByText(/server settings found/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^imap host$/i)).toBeInTheDocument();
    // No create call happened.
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("on test failure via ApiError shows the server's error message inline", async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(400, "Could not connect to the server"));

    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
    await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
    await fillEmailAndPassword(user);

    await user.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => {
      expect(screen.getByText("Could not connect to the server")).toBeInTheDocument();
    });
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("surfaces a Save ApiError to the user without calling onSuccess", async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true }); // test
    vi.mocked(apiPost).mockRejectedValueOnce(
      new ApiError(500, "Could not create the IMAP connection")
    ); // create

    const user = userEvent.setup();
    const { onSuccess } = renderStep();

    await user.type(screen.getByLabelText(/^imap host$/i), "imap.example.com");
    await user.type(screen.getByLabelText(/^smtp host$/i), "smtp.example.com");
    await fillEmailAndPassword(user);

    await user.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => {
      expect(screen.getByText("Could not create the IMAP connection")).toBeInTheDocument();
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });
});
