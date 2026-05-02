import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import InviteClaimPage from "@/app/invite/[token]/page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  useParams: () => ({
    token: "test-token-123",
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

describe("Invite Claim Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render 'You've been invited to Pinchy' heading", () => {
    render(<InviteClaimPage />);
    expect(screen.getByText("You've been invited to Pinchy")).toBeInTheDocument();
  });

  it("should render Name, Password, and Confirm password input fields", () => {
    render(<InviteClaimPage />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it("should render a show/hide toggle on the password field", () => {
    render(<InviteClaimPage />);
    expect(screen.getAllByRole("button", { name: /show password/i }).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("should toggle password visibility when clicking the toggle button", async () => {
    const user = userEvent.setup();
    render(<InviteClaimPage />);

    const passwordInput = screen.getByLabelText(/^password$/i);
    expect(passwordInput).toHaveAttribute("type", "password");

    const toggle = screen.getAllByRole("button", { name: /show password/i })[0];
    await user.click(toggle);
    expect(passwordInput).toHaveAttribute("type", "text");
  });

  it("should render a 'Create account' submit button", () => {
    render(<InviteClaimPage />);
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("should show validation error when name is empty", async () => {
    const user = userEvent.setup();
    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error when password is too short", async () => {
    const user = userEvent.setup();
    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "short");
    await user.type(screen.getByLabelText(/confirm password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Password must be at least 12 characters")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error inline when password is in the breach-list (no API roundtrip)", async () => {
    const user = userEvent.setup();
    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "passwordpassword");
    await user.type(screen.getByLabelText(/confirm password/i), "passwordpassword");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Password is too common. Please choose a less predictable one.")
      ).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error when passwords do not match", async () => {
    const user = userEvent.setup();
    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "different456");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show error when API returns error", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid or expired invite link" }),
    });

    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid or expired invite link")).toBeInTheDocument();
    });
  });

  it("should submit to /api/invite/claim with token, name, and password", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "test-token-123",
          name: "Test User",
          password: "Br1ghtNova!2",
        }),
      });
    });
  });

  it("should redirect to /login on success via 'Continue to sign in' button", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(<InviteClaimPage />);

    await user.type(screen.getByLabelText(/name/i), "Test User");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));
    expect(pushMock).toHaveBeenCalledWith("/login");
  });
});
