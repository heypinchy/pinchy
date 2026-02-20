import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import LoginPage from "@/app/login/page";
import { signIn } from "next-auth/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
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

describe("Login Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render the Pinchy logo", () => {
    render(<LoginPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should display 'Sign in to Pinchy' as title", () => {
    render(<LoginPage />);
    expect(screen.getByText("Sign in to Pinchy")).toBeInTheDocument();
  });

  it("should display login description", () => {
    render(<LoginPage />);
    expect(screen.getByText("Enter the credentials you created during setup.")).toBeInTheDocument();
  });

  it("should render email and password fields", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("should have a 'Sign in' button", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("should show validation error for invalid email", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/password/i), "somepassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email address")).toBeInTheDocument();
    });

    expect(signIn).not.toHaveBeenCalled();
  });

  it("should show validation error when password is empty", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Password is required")).toBeInTheDocument();
    });

    expect(signIn).not.toHaveBeenCalled();
  });

  it("should call signIn with form values on valid submission", async () => {
    const user = userEvent.setup();
    vi.mocked(signIn).mockResolvedValue({ error: undefined, ok: true, status: 200, url: "/" });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "mypassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("credentials", {
        email: "user@example.com",
        password: "mypassword",
        redirect: false,
      });
    });
  });

  it("should display API error when signIn returns an error", async () => {
    const user = userEvent.setup();
    vi.mocked(signIn).mockResolvedValue({
      error: "CredentialsSignin",
      ok: false,
      status: 401,
      url: null,
    });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrongpassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
    });
  });
});
