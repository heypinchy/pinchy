import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { EnterpriseBanner } from "@/components/enterprise-banner";

function statusJson(overrides: Record<string, unknown> = {}) {
  return {
    enterprise: true,
    type: "paid",
    daysRemaining: 200,
    expiresAt: new Date(Date.now() + 200 * 86400000).toISOString(),
    ...overrides,
  };
}

function mockStatusResponse(data: object) {
  return { ok: true, json: async () => data } as Response;
}

describe("EnterpriseBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when not admin", () => {
    const { container } = render(<EnterpriseBanner isAdmin={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when license is active with plenty of time", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: true,
        type: "paid",
        daysRemaining: 200,
        expiresAt: new Date(Date.now() + 200 * 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing when no license (no banner, handled by Settings)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: false,
        type: null,
        daysRemaining: null,
        expiresAt: null,
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders yellow banner for trial with 7 days remaining", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: true,
        type: "trial",
        daysRemaining: 7,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/trial expires in 7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/upgrade/i)).toBeInTheDocument();
  });

  it("renders red banner for trial with 2 days remaining", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: true,
        type: "trial",
        daysRemaining: 2,
        expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/trial expires in 2 days/i)).toBeInTheDocument();
  });

  it("renders yellow banner for paid with 25 days remaining", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: true,
        type: "paid",
        daysRemaining: 25,
        expiresAt: new Date(Date.now() + 25 * 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/license expires in 25 days/i)).toBeInTheDocument();
    expect(screen.getByText(/renew/i)).toBeInTheDocument();
  });

  it("renders red banner for paid with 5 days remaining", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: true,
        type: "paid",
        daysRemaining: 5,
        expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/license expires in 5 days/i)).toBeInTheDocument();
  });

  it("renders red banner when expired", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        enterprise: false,
        type: "trial",
        daysRemaining: 0,
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
      }),
    });

    render(<EnterpriseBanner isAdmin={true} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/license has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/enter new key/i)).toBeInTheDocument();
  });

  describe("re-fetch triggers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-fetches when the tab becomes visible", async () => {
      mockFetch.mockResolvedValue(mockStatusResponse(statusJson()));
      render(<EnterpriseBanner isAdmin={true} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    });

    it("does not re-fetch when the tab becomes hidden", async () => {
      mockFetch.mockResolvedValue(mockStatusResponse(statusJson()));
      render(<EnterpriseBanner isAdmin={true} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // Give any stray promises a chance to land
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("re-fetches periodically (every 15 minutes)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockFetch.mockResolvedValue(mockStatusResponse(statusJson()));
      render(<EnterpriseBanner isAdmin={true} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("re-fetches when a 'license-updated' event is dispatched", async () => {
      mockFetch.mockResolvedValue(mockStatusResponse(statusJson()));
      render(<EnterpriseBanner isAdmin={true} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await act(async () => {
        window.dispatchEvent(new Event("license-updated"));
      });
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    });

    it("removes listeners and timers on unmount", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockFetch.mockResolvedValue(mockStatusResponse(statusJson()));
      const { unmount } = render(<EnterpriseBanner isAdmin={true} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      unmount();
      mockFetch.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        window.dispatchEvent(new Event("license-updated"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
