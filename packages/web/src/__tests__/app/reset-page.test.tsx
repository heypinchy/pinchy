import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ResetPasswordPage from "@/app/reset/[token]/page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  useParams: () => ({
    token: "reset-token-abc",
  }),
}));

vi.mock("next/image", () => ({
  default: ({
    priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

global.fetch = vi.fn();

describe("Reset Password Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render 'Reset your password' heading", () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText("Reset your password")).toBeInTheDocument();
  });

  it("should render description text", () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText("Enter a new password for your account.")).toBeInTheDocument();
  });

  it("should NOT render a Name field", () => {
    render(<ResetPasswordPage />);
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it("should render Password and Confirm password fields", () => {
    render(<ResetPasswordPage />);
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it("should render a 'Reset password' submit button", () => {
    render(<ResetPasswordPage />);
    expect(screen.getByRole("button", { name: /reset password/i })).toBeInTheDocument();
  });

  it("should show validation error when password is too short", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "short");
    await user.type(screen.getByLabelText(/confirm password/i), "short");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByText("Password must be at least 8 characters")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error when passwords do not match", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.type(screen.getByLabelText(/confirm password/i), "different456");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should submit to /api/invite/claim with token and password (no name)", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.type(screen.getByLabelText(/confirm password/i), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "reset-token-abc",
          password: "password123",
        }),
      });
    });
  });

  it("should show error when API returns error", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid or expired invite link" }),
    });

    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.type(screen.getByLabelText(/confirm password/i), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid or expired invite link")).toBeInTheDocument();
    });
  });

  it("should show success screen with 'Password reset!' after successful submit", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.type(screen.getByLabelText(/confirm password/i), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByText("Password reset!")).toBeInTheDocument();
    });
    expect(screen.getByText("You can now sign in with your new password.")).toBeInTheDocument();
  });

  it("should redirect to /login via 'Continue to sign in' button after success", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.type(screen.getByLabelText(/confirm password/i), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));
    expect(pushMock).toHaveBeenCalledWith("/login");
  });
});
