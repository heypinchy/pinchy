import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import LoginPage from "@/app/login/page";
import { SIGN_IN_RATE_LIMIT_WINDOW_SECONDS } from "@/lib/auth-rate-limit";

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
    // The real shape Better Auth sends for a rejected credential: 401 with
    // INVALID_EMAIL_OR_PASSWORD (better-auth's sign-in route throws
    // UNAUTHORIZED for an unknown user, a missing account and a bad password
    // alike). `status` is required on a BetterFetchError, so a status-less
    // fixture would test a response the client can never produce.
    mockSignInEmail.mockResolvedValue({
      error: {
        status: 401,
        statusText: "UNAUTHORIZED",
        message: "Invalid email or password",
        code: "INVALID_EMAIL_OR_PASSWORD",
      },
    });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "wrongpassword");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
    });
  });

  // Only a 401 means the credentials were wrong. Reporting any other failure as
  // "Invalid email or password" sends the user hunting for a password that was
  // right all along, and hides the one fact that would actually help them.
  describe("sign-in failures are reported by cause, not all as a wrong password", () => {
    async function submitLogin(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByLabelText(/email/i), "user@example.com");
      await user.type(screen.getByLabelText("Password"), "correct-password-123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));
    }

    // With the production limit of 5 attempts/60s (see getAuthRateLimitConfig),
    // a few typos lock the account out and every retry re-arms the window — so
    // a user who hammers the button stays locked out while the page insists
    // their (correct) password is bad.
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

    // The wait we promise must be the wait the server actually enforces, so the
    // message is pinned to the same constant getAuthRateLimitConfig uses.
    it("tells the user to wait as long as the server actually throttles them", async () => {
      const user = userEvent.setup();
      mockSignInEmail.mockResolvedValue({
        error: { status: 429, statusText: "Too Many Requests", message: "Too many requests." },
      });

      render(<LoginPage />);
      await submitLogin(user);

      await waitFor(() => {
        expect(screen.getByText(/too many sign-in attempts/i)).toHaveTextContent(
          `${SIGN_IN_RATE_LIMIT_WINDOW_SECONDS} seconds`
        );
      });
    });

    // 403 is only reachable *after* the password verified: better-auth rejects a
    // bad credential with 401, and reaches FORBIDDEN only for a banned user (the
    // admin plugin's session.create.before hook — which is how Pinchy deactivates
    // an account) or an unverified email. Telling that user their password is
    // wrong is the exact dead end this whole describe block exists to prevent.
    it("reports a deactivated account as such, not as a wrong password", async () => {
      const user = userEvent.setup();
      mockSignInEmail.mockResolvedValue({
        error: {
          status: 403,
          statusText: "FORBIDDEN",
          message: "You have been banned from this application.",
          code: "BANNED_USER",
        },
      });

      render(<LoginPage />);
      await submitLogin(user);

      await waitFor(() => {
        expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
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

    // No BetterFetchError is status-less, but an unrecognized failure must not
    // be guessed into a password accusation either.
    it("falls back to a generic failure when the error has no status", async () => {
      const user = userEvent.setup();
      mockSignInEmail.mockResolvedValue({ error: { message: "something unexpected" } });

      render(<LoginPage />);
      await submitLogin(user);

      await waitFor(() => {
        expect(screen.getByText(/login failed\. please try again/i)).toBeInTheDocument();
      });
      expect(screen.queryByText("Invalid email or password")).not.toBeInTheDocument();
    });

    // The error text is the entire point of this page's failure path — a screen
    // reader user has to hear it change, not just sighted users see it.
    it("announces the error to screen readers", async () => {
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
        expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password");
      });
    });
  });
});
