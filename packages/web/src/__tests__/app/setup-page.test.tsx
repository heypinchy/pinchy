import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import SetupPage from "@/app/setup/page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
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

describe("Setup Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render the Pinchy logo", () => {
    render(<SetupPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should display 'Welcome to Pinchy' as title", () => {
    render(<SetupPage />);
    expect(screen.getByText("Welcome to Pinchy")).toBeInTheDocument();
  });

  it("should display setup description", () => {
    render(<SetupPage />);
    expect(
      screen.getByText("Create your admin account. You'll use these credentials to sign in.")
    ).toBeInTheDocument();
  });

  it("should render name, email, and password fields", () => {
    render(<SetupPage />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("should render name field before email field", () => {
    render(<SetupPage />);
    const nameInput = screen.getByLabelText(/name/i);
    const emailInput = screen.getByLabelText(/email/i);
    // Name should come before email in the DOM
    expect(
      nameInput.compareDocumentPosition(emailInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("should have a 'Create account' button", () => {
    render(<SetupPage />);
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("should show validation error when name is empty", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error for invalid email", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email address")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error when password is too short", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Password must be at least 8 characters")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should submit name along with email and password", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Admin User",
          email: "admin@test.com",
          password: "password123",
        }),
      });
    });
  });

  it("should show success state after successful setup", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Account created successfully!")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
  });

  it("should navigate to /login when clicking 'Continue to sign in'", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));
    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  it("should show error message on failed setup", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Setup already completed" }),
    });

    render(<SetupPage />);

    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Setup already completed")).toBeInTheDocument();
    });
  });
});
