import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const { pushMock, mockRedirect, mockIsSetupComplete } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  mockRedirect: vi.fn(),
  mockIsSetupComplete: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  redirect: mockRedirect,
  usePathname: () => "/setup",
}));

vi.mock("next/image", () => ({
  default: ({ ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: mockIsSetupComplete,
}));

vi.mock("@/lib/github-issue", () => ({
  buildGitHubIssueUrl: vi.fn().mockReturnValue("https://github.com/test"),
  buildIssueBody: vi.fn().mockReturnValue("issue body"),
  fetchDiagnostics: vi.fn().mockResolvedValue(null),
}));

import { SetupForm, PREFLIGHT_CONFIG } from "@/components/setup-form";
import SetupPage, * as SetupPageModule from "@/app/setup/page";

global.fetch = vi.fn();

function mockFetchSetupStatus(infrastructure?: { database: string; openclaw: string }) {
  (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === "/api/setup/status") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          setupComplete: false,
          infrastructure: infrastructure ?? { database: "connected", openclaw: "connected" },
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe("Setup Form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSetupStatus();
  });

  it("should display 'Welcome to Pinchy' as title", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByText("Welcome to Pinchy")).toBeInTheDocument();
    });
  });

  it("should display setup description", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(
        screen.getByText("Create your admin account. You'll use these credentials to sign in.")
      ).toBeInTheDocument();
    });
  });

  it("should render name, email, password, and confirm password fields", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it("should render a show/hide toggle on the password field", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: /show password/i }).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("should toggle password visibility when clicking the toggle button", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    });

    const passwordInput = screen.getByLabelText(/^password$/i);
    expect(passwordInput).toHaveAttribute("type", "password");

    const toggle = screen.getAllByRole("button", { name: /show password/i })[0];
    await user.click(toggle);
    expect(passwordInput).toHaveAttribute("type", "text");
  });

  it("should render name field before email field", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    const nameInput = screen.getByLabelText(/name/i);
    const emailInput = screen.getByLabelText(/email/i);
    expect(
      nameInput.compareDocumentPosition(emailInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("should have a 'Create account' button", async () => {
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
    });
  });

  it("should show validation error when name is empty", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });
  });

  it("should show validation error for invalid email", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid email address")).toBeInTheDocument();
    });
  });

  it("should show validation error when password is too short", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "short");
    await user.type(screen.getByLabelText(/confirm password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Password must be at least 12 characters")).toBeInTheDocument();
    });
  });

  it("should show validation error inline when password is in the breach-list (no API roundtrip)", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "passwordpassword");
    await user.type(screen.getByLabelText(/confirm password/i), "passwordpassword");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Password is too common. Please choose a less predictable one.")
      ).toBeInTheDocument();
    });
    // Preflight calls /api/setup/status — we just need to confirm no POST to /api/setup
    const setupPosts = vi
      .mocked(global.fetch)
      .mock.calls.filter(
        ([url, init]) => typeof url === "string" && url === "/api/setup" && init?.method === "POST"
      );
    expect(setupPosts).toHaveLength(0);
  });

  it("should show validation error when passwords do not match", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "different456");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalledWith("/api/setup", expect.anything());
  });

  it("should submit name along with email and password", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Admin User",
          email: "admin@test.com",
          password: "Br1ghtNova!2",
        }),
      });
    });
  });

  it("should show success state after successful setup", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Account created successfully!")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
  });

  it("should navigate to /login when clicking 'Continue to sign in'", async () => {
    const user = userEvent.setup();
    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));
    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  it("should show error message on failed setup", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/api/setup/status") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            setupComplete: false,
            infrastructure: { database: "connected", openclaw: "connected" },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: async () => ({ error: "Setup already completed" }),
      });
    });

    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Setup already completed")).toBeInTheDocument();
    });
  });

  it("should show report issue link when error occurs", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/api/setup/status") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            setupComplete: false,
            infrastructure: { database: "connected", openclaw: "connected" },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: async () => ({ error: "Setup already completed" }),
      });
    });

    render(<SetupForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/name/i), "Admin User");
    await user.type(screen.getByLabelText(/email/i), "admin@test.com");
    await user.type(screen.getByLabelText(/^password$/i), "Br1ghtNova!2");
    await user.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("Setup already completed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
    });
  });
});

describe("Setup Form pre-flight checks", () => {
  const originalConfig = { ...PREFLIGHT_CONFIG };

  beforeEach(() => {
    vi.clearAllMocks();
    // Use fast retries in tests
    PREFLIGHT_CONFIG.maxRetries = 3;
    PREFLIGHT_CONFIG.retryIntervalMs = 50;
  });

  afterEach(() => {
    Object.assign(PREFLIGHT_CONFIG, originalConfig);
  });

  it("should show loading state while checking infrastructure", () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<SetupForm />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it("should show form when infrastructure is healthy", async () => {
    mockFetchSetupStatus({ database: "connected", openclaw: "connected" });
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByText("Welcome to Pinchy")).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });

  it("should retry automatically before showing infrastructure error", async () => {
    let callCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/api/setup/status") {
        callCount++;
        const openclaw = callCount <= 2 ? "unreachable" : "connected";
        return Promise.resolve({
          ok: true,
          json: async () => ({
            setupComplete: false,
            infrastructure: { database: "connected", openclaw },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<SetupForm />);

    // Should eventually show the form (not the error) after retries succeed
    await waitFor(() => {
      expect(screen.getByText("Welcome to Pinchy")).toBeInTheDocument();
    });
  });

  it("should show error when database is unreachable after retries exhausted", async () => {
    mockFetchSetupStatus({ database: "unreachable", openclaw: "connected" });
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByText(/database/i)).toBeInTheDocument();
      expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it("should show error when OpenClaw is unreachable after retries exhausted", async () => {
    mockFetchSetupStatus({ database: "connected", openclaw: "unreachable" });
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByText(/OpenClaw/i)).toBeInTheDocument();
      expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it("should show report issue link when infrastructure check fails", async () => {
    mockFetchSetupStatus({ database: "unreachable", openclaw: "connected" });
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
    });
  });

  it("should show retry button when infrastructure check fails", async () => {
    mockFetchSetupStatus({ database: "unreachable", openclaw: "connected" });
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    });
  });

  it("should show form when status fetch fails entirely (graceful fallback)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    render(<SetupForm />);
    await waitFor(() => {
      expect(screen.getByText("Welcome to Pinchy")).toBeInTheDocument();
    });
  });
});

describe("Setup Page (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((url: string) => {
      throw new Error(`NEXT_REDIRECT: ${url}`);
    });
  });

  it("should redirect to / when setup is already complete", async () => {
    mockIsSetupComplete.mockResolvedValue(true);
    await expect(SetupPage()).rejects.toThrow("NEXT_REDIRECT: /");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("should force dynamic rendering to avoid build-time DB queries", () => {
    expect(SetupPageModule.dynamic).toBe("force-dynamic");
  });
});
