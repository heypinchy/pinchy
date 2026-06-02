import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The page makes two distinct fetches: a GET to /api/invite/[token] on mount to
// learn the flow type, and a POST to /api/invite/claim on submit. We route the
// mock by URL+method rather than by call order so the tests don't break if the
// page ever changes how many requests it makes.
type MockResponse = { ok: boolean; body: unknown };
let getResponse: MockResponse | "pending";
let postResponse: MockResponse;

global.fetch = vi.fn();

function mockTokenType(type: "invite" | "reset") {
  getResponse = { ok: true, body: { type } };
}
function mockTokenError(error: string) {
  getResponse = { ok: false, body: { error } };
}
function mockTokenPending() {
  getResponse = "pending";
}
function mockSubmit(response: MockResponse) {
  postResponse = response;
}

describe("Invite Claim Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getResponse = { ok: true, body: { type: "invite" } };
    postResponse = { ok: true, body: { success: true } };
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.startsWith("/api/invite/")) {
          if (getResponse === "pending") return new Promise(() => {});
          return Promise.resolve({ ok: getResponse.ok, json: async () => getResponse.body });
        }
        if (method === "POST" && url === "/api/invite/claim") {
          return Promise.resolve({ ok: postResponse.ok, json: async () => postResponse.body });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }
    );
  });

  describe("loading", () => {
    it("shows a loading indicator until the invite type resolves", () => {
      mockTokenPending();
      render(<InviteClaimPage />);

      expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
      expect(screen.queryByText("You've been invited to Pinchy")).not.toBeInTheDocument();
    });
  });

  describe("new-user invite flow", () => {
    it("loads the invite type from GET /api/invite/[token] on mount", async () => {
      mockTokenType("invite");
      render(<InviteClaimPage />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/invite/test-token-123");
      });
    });

    it("should render 'You've been invited to Pinchy' heading", async () => {
      mockTokenType("invite");
      render(<InviteClaimPage />);
      expect(await screen.findByText("You've been invited to Pinchy")).toBeInTheDocument();
    });

    it("should render Name, Password, and Confirm password input fields", async () => {
      mockTokenType("invite");
      render(<InviteClaimPage />);
      expect(await screen.findByLabelText(/name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });

    it("should render a show/hide toggle on the password field", async () => {
      mockTokenType("invite");
      render(<InviteClaimPage />);
      await screen.findByLabelText(/^password$/i);
      expect(
        screen.getAllByRole("button", { name: /show password/i }).length
      ).toBeGreaterThanOrEqual(1);
    });

    it("should toggle password visibility when clicking the toggle button", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      render(<InviteClaimPage />);

      const passwordInput = await screen.findByLabelText(/^password$/i);
      expect(passwordInput).toHaveAttribute("type", "password");

      const toggle = screen.getAllByRole("button", { name: /show password/i })[0];
      await user.click(toggle);
      expect(passwordInput).toHaveAttribute("type", "text");
    });

    it("should render a 'Create account' submit button", async () => {
      mockTokenType("invite");
      render(<InviteClaimPage />);
      expect(await screen.findByRole("button", { name: /create account/i })).toBeInTheDocument();
    });

    it("should show validation error when name is empty", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/^password$/i), "Br1ghtNova!2");
      await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByText("Name is required")).toBeInTheDocument();
      });

      // No POST to claim — validation blocked it (only the mount GET happened).
      expect(global.fetch).not.toHaveBeenCalledWith(
        "/api/invite/claim",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should show validation error when password is too short", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
      await user.type(screen.getByLabelText(/^password$/i), "short");
      await user.type(screen.getByLabelText(/confirm password/i), "short");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByText("Password must be at least 12 characters")).toBeInTheDocument();
      });

      expect(global.fetch).not.toHaveBeenCalledWith(
        "/api/invite/claim",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should show validation error inline when password is in the breach-list (no API roundtrip)", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
      await user.type(screen.getByLabelText(/^password$/i), "passwordpassword");
      await user.type(screen.getByLabelText(/confirm password/i), "passwordpassword");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(
          screen.getByText("Password is too common. Please choose a less predictable one.")
        ).toBeInTheDocument();
      });

      expect(global.fetch).not.toHaveBeenCalledWith(
        "/api/invite/claim",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should show validation error when passwords do not match", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
      await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
      await user.type(screen.getByLabelText(/confirm password/i), "different456");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
      });

      expect(global.fetch).not.toHaveBeenCalledWith(
        "/api/invite/claim",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should show a toast when the claim API returns an error", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      mockSubmit({ ok: false, body: { error: "Invalid or expired invite link" } });

      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
      await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
      await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Invalid or expired invite link");
      });
    });

    it("should submit to /api/invite/claim with token, name, and password", async () => {
      const user = userEvent.setup();
      mockTokenType("invite");
      mockSubmit({ ok: true, body: { success: true } });

      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
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
      mockTokenType("invite");
      mockSubmit({ ok: true, body: { success: true } });

      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/name/i), "Test User");
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

  describe("password-reset flow", () => {
    it("should render the reset-specific heading and subtitle", async () => {
      mockTokenType("reset");
      render(<InviteClaimPage />);

      expect(await screen.findByText("Reset your Pinchy password")).toBeInTheDocument();
      expect(screen.getByText("Set a new password for your account.")).toBeInTheDocument();
    });

    it("should NOT render a Name field", async () => {
      mockTokenType("reset");
      render(<InviteClaimPage />);

      // Wait for the form to load, then assert the name field is absent.
      await screen.findByLabelText(/^password$/i);
      expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    });

    it("should render Password and Confirm password fields", async () => {
      mockTokenType("reset");
      render(<InviteClaimPage />);

      expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });

    it("should render a 'Reset password' submit button", async () => {
      mockTokenType("reset");
      render(<InviteClaimPage />);

      expect(await screen.findByRole("button", { name: /reset password/i })).toBeInTheDocument();
    });

    it("should submit to /api/invite/claim with token and password but NO name", async () => {
      const user = userEvent.setup();
      mockTokenType("reset");
      mockSubmit({ ok: true, body: { success: true } });

      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/^password$/i), "Br1ghtNova!2");
      await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
      await user.click(screen.getByRole("button", { name: /reset password/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/invite/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "test-token-123",
            password: "Br1ghtNova!2",
          }),
        });
      });
    });

    it("should show a reset-specific success screen", async () => {
      const user = userEvent.setup();
      mockTokenType("reset");
      mockSubmit({ ok: true, body: { success: true } });

      render(<InviteClaimPage />);

      await user.type(await screen.findByLabelText(/^password$/i), "Br1ghtNova!2");
      await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
      await user.click(screen.getByRole("button", { name: /reset password/i }));

      expect(await screen.findByText("Password reset!")).toBeInTheDocument();
    });
  });

  describe("invalid token", () => {
    it("shows an error when the token is invalid or expired", async () => {
      mockTokenError("Invalid or expired invite link");
      render(<InviteClaimPage />);

      expect(await screen.findByText("Invalid or expired invite link")).toBeInTheDocument();
      expect(screen.getByText("This link can't be used")).toBeInTheDocument();
    });
  });
});
