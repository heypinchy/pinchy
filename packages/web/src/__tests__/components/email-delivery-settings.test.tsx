// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { EmailDeliverySettings } from "@/components/email-delivery-settings";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const configured = {
  configured: true,
  config: {
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "pinchy@example.com",
    fromAddress: "pinchy@example.com",
    hasPassword: true,
  },
};

function lastCall(url: string) {
  const call = [...vi.mocked(global.fetch).mock.calls].reverse().find(([u]) => u === url);
  return call
    ? { init: call[1] as RequestInit, body: JSON.parse(String(call[1]?.body ?? "{}")) }
    : null;
}

// Radix UI Select uses pointer capture and scrollIntoView, which jsdom lacks.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

describe("EmailDeliverySettings", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });
  afterEach(() => fetchSpy.mockRestore());

  it("is off by default and says the links are shown for copying", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ configured: false }));
    render(<EmailDeliverySettings />);
    expect(await screen.findByText(/Pinchy doesn't send email/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up email" })).toBeInTheDocument();
    expect(screen.queryByLabelText("SMTP server")).not.toBeInTheDocument();
  });

  it("asks for server, sender, username and password — port and encryption are derived", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ configured: false }));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));

    expect(screen.getByLabelText("SMTP server")).toBeInTheDocument();
    expect(screen.getByLabelText("Sender address")).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Port")).not.toBeInTheDocument();
    expect(screen.getByText("Port 587 · STARTTLS")).toBeInTheDocument();
  });

  it("prefills the username from the sender address until it is touched", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ configured: false }));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));

    await user.type(screen.getByLabelText("Sender address"), "it@acme.io");
    expect(screen.getByLabelText(/Username/)).toHaveValue("it@acme.io");

    await user.clear(screen.getByLabelText(/Username/));
    await user.type(screen.getByLabelText(/Username/), "relay-user");
    await user.type(screen.getByLabelText("Sender address"), "x");
    expect(screen.getByLabelText(/Username/)).toHaveValue("relay-user");
  });

  it("switches the encryption to TLS when the admin picks port 465", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ configured: false }));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));
    await user.click(screen.getByRole("button", { name: "Change" }));

    const port = screen.getByLabelText("Port");
    await user.clear(port);
    await user.type(port, "465");
    expect(screen.getByLabelText("Encryption")).toHaveTextContent("TLS");
  });

  it("saves through PUT, and turns on", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ configured: false }))
      .mockResolvedValueOnce(jsonResponse(configured));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");
    await user.type(screen.getByLabelText("Sender address"), "pinchy@example.com");
    await user.type(screen.getByLabelText(/Password/), "s3cret");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const put = lastCall("/api/settings/mail");
    expect(put?.init.method).toBe("PUT");
    expect(put?.body).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "pinchy@example.com",
      password: "s3cret",
      fromAddress: "pinchy@example.com",
    });
    expect(
      await screen.findByText("smtp.example.com:587 · STARTTLS · from pinchy@example.com")
    ).toBeInTheDocument();
  });

  it("shows a failed verification inline and keeps the form open", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ configured: false }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Authentication failed — check the username and password" },
          { status: 400 }
        )
      );
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");
    await user.type(screen.getByLabelText("Sender address"), "pinchy@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Authentication failed — check the username and password")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("SMTP server")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("when editing, does not send a password the admin didn't retype", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockResolvedValueOnce(jsonResponse(configured));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText(/Password/)).toHaveAttribute(
      "placeholder",
      "Leave empty to keep the saved password"
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastCall("/api/settings/mail")?.init.method).toBe("PUT"));
    expect(lastCall("/api/settings/mail")?.body).not.toHaveProperty("password");
  });

  it("stops promising to keep the saved password once encryption is switched off", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse(configured));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByLabelText("Encryption"));
    await user.click(await screen.findByRole("option", { name: "None" }));

    expect(screen.getByLabelText(/Password/)).toHaveAttribute(
      "placeholder",
      "Enter the password again to use this connection"
    );
  });

  it("sends a test email to the admin and says where it went", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockResolvedValueOnce(jsonResponse({ sent: true, to: "admin@example.com" }));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Send test email" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Test email sent to admin@example.com")
    );
  });

  it("shows a failed test send inline — it is a setting to fix, not a hiccup", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockResolvedValueOnce(
        jsonResponse({ error: "The mail server refused the sender address" }, { status: 502 })
      );
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Send test email" }));
    expect(
      await screen.findByText("The mail server refused the sender address")
    ).toBeInTheDocument();
  });

  it("turns off", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockResolvedValueOnce(jsonResponse({ configured: false }));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/Pinchy doesn't send email/)).toBeInTheDocument();
    expect(lastCall("/api/settings/mail")?.init.method).toBe("DELETE");
  });

  it("names the field a validation error is about, under that field", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ configured: false }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Validation failed",
            details: { fieldErrors: { fromAddress: ["Enter a valid sender address"] } },
          },
          { status: 400 }
        )
      );
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Set up email" }));
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");
    await user.type(screen.getByLabelText("Sender address"), "it@acme");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a valid sender address")).toBeInTheDocument();
    expect(screen.queryByText("Validation failed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Sender address")).toHaveAttribute("aria-invalid", "true");
  });

  it("stops promising to keep the password once the server changes", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse(configured));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const host = screen.getByLabelText("SMTP server");
    await user.clear(host);
    await user.type(host, "smtp.other.com");
    expect(screen.getByLabelText(/Password/)).toHaveAttribute(
      "placeholder",
      "Enter the password for this server"
    );
  });

  it("does not let a double click turn off twice", async () => {
    let resolveDelete: (r: Response) => void = () => {};
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockImplementationOnce(() => new Promise<Response>((r) => (resolveDelete = r)));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    const button = await screen.findByRole("button", { name: "Turn off" });
    await user.click(button);
    expect(button).toBeDisabled();
    resolveDelete(jsonResponse({ configured: false }));
    expect(await screen.findByText(/Pinchy doesn't send email/)).toBeInTheDocument();
  });

  it("says the password isn't used while there is no username", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse(configured));
    const user = userEvent.setup();
    render(<EmailDeliverySettings />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText(/Username/));
    expect(screen.getByLabelText(/Password/)).toHaveAttribute(
      "placeholder",
      "Not used without a username"
    );
  });
});
