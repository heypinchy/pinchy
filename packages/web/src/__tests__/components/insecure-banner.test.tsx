// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/domain", () => ({
  isInsecureMode: vi.fn(),
}));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

import { InsecureBanner } from "@/components/insecure-banner";
import { isInsecureMode } from "@/lib/domain";

/**
 * Requests arrive at a real domain unless a test says otherwise.
 *
 * `x-forwarded-host` is back-filled from `host` because that is what Next.js
 * itself does to every request that lacks one (`base-server.js`) — a fixture
 * without it describes a request that never reaches a Server Component, and an
 * earlier version of this suite passed against exactly that fiction while the
 * feature did nothing. `extra` overrides it to model a real proxy.
 */
function requestFrom(host: string, extra: Record<string, string> = {}) {
  mockHeaders.mockResolvedValue(
    new Headers({ host, "x-forwarded-host": host, "x-forwarded-proto": "http", ...extra })
  );
}

describe("InsecureBanner", () => {
  beforeEach(() => {
    vi.mocked(isInsecureMode).mockReset();
    mockHeaders.mockReset();
    requestFrom("pinchy.example.com");
  });

  it("should render nothing when not in insecure mode", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(false);
    const Component = await InsecureBanner({ isAdmin: true });
    const { container } = render(Component);
    expect(container.innerHTML).toBe("");
  });

  it("should render warning banner when in insecure mode", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/not secured/i)).toBeDefined();
  });

  it("should show settings link for admins", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    const link = screen.getByText(/secure your instance/i);
    expect(link.closest("a")?.getAttribute("href")).toBe("/settings?tab=security");
  });

  it("uses AA-contrast dark text on amber, not white (white-on-amber-500 is ~2.1:1)", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    const banner = screen.getByRole("alert");
    expect(banner.className).not.toContain("text-white");
    expect(banner.className).toContain("text-amber-950");
  });

  it("exposes a stable data-testid so screenshot tooling can hide it", async () => {
    // The screenshot capture pipeline hides this banner via a CSS selector on
    // [data-testid="insecure-banner"]. Keep the hook stable so a refactor can't
    // silently re-expose the "not secured" warning in marketing screenshots.
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert").getAttribute("data-testid")).toBe("insecure-banner");
  });

  it("stays silent on a local install, where the advice cannot be acted on", async () => {
    // A browser already treats http://localhost as a secure context, and there
    // is no domain to lock. The warning would be wrong, not merely noisy.
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    requestFrom("localhost:7777");
    const Component = await InsecureBanner({ isAdmin: true });
    const { container } = render(Component);
    expect(container.innerHTML).toBe("");
  });

  it("still warns a proxied instance that merely looks local from inside", async () => {
    // The case worth protecting: behind a proxy the `Host` header describes the
    // hop into the container, so a PUBLIC instance can report `localhost`.
    // Suppressing the banner there would hide it from precisely the operator
    // who needs it, so the forwarded client-facing host decides instead.
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    requestFrom("localhost:7777", { "x-forwarded-host": "pinchy.example.com" });
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("keeps warning a loopback host reached over HTTPS, where locking IS possible", async () => {
    // The gap the host comparison alone cannot close: nginx `proxy_pass
    // http://localhost:7777` without `proxy_set_header Host` rewrites `Host` to
    // `localhost` and sets no `X-Forwarded-Host`, so a PUBLIC instance looks
    // local by every host-shaped measure.
    //
    // The scheme still gives it away. Next derives its back-fill from
    // `socket.encrypted`, so a plain-HTTP container cannot manufacture `https`
    // — whoever set it terminated TLS. And over HTTPS the banner's advice is
    // actionable rather than empty: `POST /api/settings/domain` gates the lock
    // on this very header, and settings then offers "Lock <host> & restart",
    // localhost included. Suppressing here would hide an action the operator
    // can actually take.
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    requestFrom("localhost:7777", { "x-forwarded-proto": "https" });
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("should show 'contact administrator' for non-admins", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: false });
    render(Component);
    expect(screen.getByText(/contact your administrator/i)).toBeDefined();
    expect(screen.queryByText(/secure your instance/i)).toBeNull();
  });
});
