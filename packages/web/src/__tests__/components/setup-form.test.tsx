import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SetupForm, PREFLIGHT_CONFIG } from "@/components/setup-form";

const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/setup",
}));

describe("SetupForm", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
    // Speed up preflight retries in tests
    PREFLIGHT_CONFIG.maxRetries = 1;
    PREFLIGHT_CONFIG.retryIntervalMs = 0;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockPreflightReady() {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ infrastructure: { database: "connected", openclaw: "connected" } }),
    } as Response);
  }

  it("shows checking state initially", () => {
    mockPreflightReady();
    render(<SetupForm />);
    expect(screen.getByText(/checking infrastructure/i)).toBeInTheDocument();
  });

  it("shows the form after preflight passes", async () => {
    mockPreflightReady();
    render(<SetupForm />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument()
    );
  });

  it("shows infrastructure error when services are unreachable", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        infrastructure: { database: "unreachable", openclaw: "unreachable" },
      }),
    } as Response);
    render(<SetupForm />);
    await waitFor(() => expect(screen.getByText(/waiting for services/i)).toBeInTheDocument());
    expect(screen.getByText(/database/i)).toBeInTheDocument();
  });

  it("shows validation error when name is empty", async () => {
    mockPreflightReady();
    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText(/name is required/i)).toBeInTheDocument());
  });

  it("shows validation error for invalid email", async () => {
    mockPreflightReady();
    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.type(screen.getByLabelText(/name/i), "Admin");
    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText(/invalid email/i)).toBeInTheDocument());
  });

  it("shows validation error when passwords do not match", async () => {
    mockPreflightReady();
    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.type(screen.getByLabelText(/name/i), "Admin");
    await userEvent.type(screen.getByLabelText(/email/i), "admin@test.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "Br1ghtNova!2");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "Different123!");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument());
  });

  it("shows success state after successful submit", async () => {
    mockPreflightReady();
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ infrastructure: { database: "connected", openclaw: "connected" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.type(screen.getByLabelText(/name/i), "Admin");
    await userEvent.type(screen.getByLabelText(/email/i), "admin@test.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "Br1ghtNova!2");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(screen.getByText(/account created successfully/i)).toBeInTheDocument()
    );
  });

  it("navigates to /login when Continue is clicked after success", async () => {
    mockPreflightReady();
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ infrastructure: { database: "connected", openclaw: "connected" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.type(screen.getByLabelText(/name/i), "Admin");
    await userEvent.type(screen.getByLabelText(/email/i), "admin@test.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "Br1ghtNova!2");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => screen.getByRole("button", { name: /continue to sign in/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue to sign in/i }));

    expect(mockRouterPush).toHaveBeenCalledWith("/login");
  });

  it("shows API error message on failed submit", async () => {
    mockPreflightReady();
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ infrastructure: { database: "connected", openclaw: "connected" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Setup already complete" }),
      } as Response);

    render(<SetupForm />);
    await waitFor(() => screen.getByRole("button", { name: /create account/i }));

    await userEvent.type(screen.getByLabelText(/name/i), "Admin");
    await userEvent.type(screen.getByLabelText(/email/i), "admin@test.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "Br1ghtNova!2");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "Br1ghtNova!2");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText(/setup already complete/i)).toBeInTheDocument());
  });
});
