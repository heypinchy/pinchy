import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import LoginPage from "@/app/login/page";

const mockSignInEmail = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => mockSignInEmail(...args),
    },
  },
}));

const mockPush = vi.fn();
const mockSearchParamsGet = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => ({
    get: mockSearchParamsGet,
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

describe("Login Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet.mockReturnValue(null);
  });

  it("should render the Pinchy logo", () => {
    render(<LoginPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.svg");
  });

  it("should display 'Sign in to Pinchy' as title", () => {
    render(<LoginPage />);
    expect(screen.getByText("Sign in to Pinchy")).toBeInTheDocument();
  });

  it("should display login description", () => {
    render(<LoginPage />);
    expect(screen.getByText("Enter your email and password to continue.")).toBeInTheDocument();
  });

  it("should submit via POST so a native pre-hydration submit can't leak credentials into the URL", () => {
    const { container } = render(<LoginPage />);
    const form = container.querySelector("form");
    expect(form).toBeInTheDocument();
    expect(form?.getAttribute("method")).toBe("post");
  });

  it("should render email and password fields", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("should have a show/hide password toggle", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");

    const toggleButton = screen.getByRole("button", { name: /show password/i });
    await user.click(toggleButton);

    expect(passwordInput).toHaveAttribute("type", "text");
  });

  it("should have a 'Sign in' button", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("should show validation error for invalid email", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText("Password"), "somepassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email address")).toBeInTheDocument();
    });

    expect(mockSignInEmail).not.toHaveBeenCalled();
  });

  it("should show validation error when password is empty", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Password is required")).toBeInTheDocument();
    });

    expect(mockSignInEmail).not.toHaveBeenCalled();
  });

  it("should call authClient.signIn.email with form values on valid submission", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({ error: null });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "mypassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "mypassword",
      });
    });
  });

  it("should redirect to / on successful login", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({ error: null });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "mypassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  it("should redirect to a safe returnTo destination on successful login", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({ error: null });
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "returnTo" ? "/share?share_id=abc" : null
    );

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "mypassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/share?share_id=abc");
    });
  });

  it("should fall back to / when returnTo is an unsafe, open-redirect-shaped value", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({ error: null });
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "returnTo" ? "//evil.com" : null
    );

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "mypassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  it("should display error when signIn returns an error", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({
      error: { message: "Invalid credentials" },
    });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "wrongpassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
    });
  });

  // Better Auth answers a rate-limited sign-in with 429 and a real server
  // failure with 5xx. Reporting either as "Invalid email or password" tells the
  // user their (correct) password is wrong and hides the actual cause: with the
  // production limit of 5 attempts/60s (see getAuthRateLimitConfig), a few
  // typos lock the account out, every retry re-arms the window, and the user is
  // told the whole time that their password is bad. Distinguish by status.
  async function submitLogin(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password-123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
  }

  it("reports rate limiting as such, not as a wrong password", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({
      error: { status: 429, statusText: "Too Many Requests", message: "Too many requests." },
    });

    render(<LoginPage />);
    await submitLogin(user);

    await waitFor(() => {
      expect(screen.getByText(/too many sign-in attempts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Invalid email or password")).not.toBeInTheDocument();
  });

  it("reports a server error as such, not as a wrong password", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({
      error: { status: 500, statusText: "Internal Server Error", message: "boom" },
    });

    render(<LoginPage />);
    await submitLogin(user);

    await waitFor(() => {
      expect(screen.getByText(/login failed\. please try again/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Invalid email or password")).not.toBeInTheDocument();
  });

  it("still reports genuinely invalid credentials as a wrong password", async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockResolvedValue({
      error: {
        status: 401,
        statusText: "UNAUTHORIZED",
        message: "Invalid email or password",
        code: "INVALID_EMAIL_OR_PASSWORD",
      },
    });

    render(<LoginPage />);
    await submitLogin(user);

    await waitFor(() => {
      expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
    });
  });
});
