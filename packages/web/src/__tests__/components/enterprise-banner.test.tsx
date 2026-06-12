import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { EnterpriseBanner } from "@/components/enterprise-banner";

const DAY = 86400000;

function statusJson(overrides: Record<string, unknown> = {}) {
  return {
    enterprise: true,
    state: "paid",
    type: "paid",
    org: "TestCo",
    daysRemaining: 200,
    expiresAt: new Date(Date.now() + 200 * DAY).toISOString(),
    paidUntil: null,
    seatsUsed: 3,
    maxUsers: 10,
    hasGatedConfig: false,
    ...overrides,
  };
}

function mockStatusResponse(data: object) {
  return { ok: true, json: async () => data } as Response;
}

async function renderWithStatus(data: object) {
  mockFetch.mockResolvedValue(mockStatusResponse(data));
  render(<EnterpriseBanner isAdmin={true} />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
}

describe("EnterpriseBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("renders nothing when not admin", () => {
    const { container } = render(<EnterpriseBanner isAdmin={false} />);
    expect(container.innerHTML).toBe("");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders nothing for community (no permanent banner — § 6)", async () => {
    await renderWithStatus(
      statusJson({
        enterprise: false,
        state: "community",
        type: null,
        expiresAt: null,
        daysRemaining: null,
        maxUsers: 0,
      })
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing for a paid license outside the renewal window", async () => {
    await renderWithStatus(
      statusJson({ paidUntil: new Date(Date.now() + 100 * DAY).toISOString() })
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a subtle trial banner with a buy CTA during the trial", async () => {
    await renderWithStatus(statusJson({ state: "trial", type: "trial", daysRemaining: 23 }));
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Trial: 23 days remaining.");
    expect(banner.className).not.toContain("bg-amber");
    const buy = screen.getByRole("link", { name: /buy pinchy pro/i });
    expect(buy).toHaveAttribute(
      "href",
      "https://buy.heypinchy.com/shop/pinchy-pro-5?utm_source=pinchy-app&utm_medium=trial-banner&utm_campaign=pro-10"
    );
    const compare = screen.getByRole("link", { name: /compare plans/i });
    expect(compare).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=trial-banner&utm_campaign=pro-10"
    );
  });

  it("emphasizes the trial banner from 7 days remaining", async () => {
    await renderWithStatus(statusJson({ state: "trial", type: "trial", daysRemaining: 7 }));
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Trial: 7 days remaining.");
    expect(banner.className).toContain("bg-amber");
  });

  it("uses the singular for one remaining day", async () => {
    await renderWithStatus(statusJson({ state: "trial", type: "trial", daysRemaining: 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Trial: 1 day remaining.");
  });

  it("shows the trial-expired banner with a pricing CTA and no re-trial button", async () => {
    const expiresAt = new Date("2026-06-01T00:00:00.000Z");
    await renderWithStatus(
      statusJson({
        enterprise: false,
        state: "trial-expired",
        type: "trial",
        daysRemaining: 0,
        expiresAt: expiresAt.toISOString(),
      })
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(
      "Your trial ended on Jun 1, 2026. Your configuration is preserved."
    );
    const pricing = screen.getByRole("link", { name: /see pricing/i });
    expect(pricing).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=expired-banner&utm_campaign=pro-10"
    );
    expect(screen.queryByText(/start free/i)).not.toBeInTheDocument();
  });

  it("shows the renewal banner from 14 days before paidUntil", async () => {
    const paidUntil = new Date(Date.now() + 10 * DAY);
    await renderWithStatus(statusJson({ paidUntil: paidUntil.toISOString() }));
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/Your license period ends on/);
    expect(banner).toHaveTextContent("Your renewal key arrives by email after payment.");
    const renew = screen.getByRole("link", { name: /renew/i });
    expect(renew).toHaveAttribute(
      "href",
      "https://buy.heypinchy.com/my?utm_source=pinchy-app&utm_medium=expired-banner&utm_campaign=pro-10"
    );
  });

  it("anchors the renewal banner on exp for legacy keys without paidUntil", async () => {
    // Keys issued before the paidUntil claim existed encode no grace —
    // exp IS the period end. Losing the reminder for those keys would be a
    // regression for every existing paid customer.
    await renderWithStatus(
      statusJson({
        paidUntil: null,
        expiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
        daysRemaining: 10,
      })
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/Your license period ends on/);
    expect(screen.getByRole("link", { name: /renew/i })).toBeInTheDocument();
  });

  it("shows the grace banner with the canonical copy", async () => {
    const paidUntil = new Date("2026-06-01T00:00:00.000Z");
    const exp = new Date("2026-07-01T00:00:00.000Z");
    await renderWithStatus(
      statusJson({
        state: "grace",
        paidUntil: paidUntil.toISOString(),
        expiresAt: exp.toISOString(),
        daysRemaining: 19,
      })
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("License period ended Jun 1, 2026. Grace until Jul 1, 2026.");
    expect(screen.getByRole("link", { name: /renew/i })).toBeInTheDocument();
  });

  it("shows the expired banner stating that restrictions remain enforced", async () => {
    const paidUntil = new Date("2026-05-01T00:00:00.000Z");
    await renderWithStatus(
      statusJson({
        enterprise: false,
        state: "expired",
        paidUntil: paidUntil.toISOString(),
        expiresAt: new Date("2026-05-31T00:00:00.000Z").toISOString(),
        daysRemaining: 0,
      })
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(
      "Your license period ended on May 1, 2026. Existing access restrictions remain enforced; management features are locked."
    );
    expect(screen.getByRole("link", { name: /renew/i })).toBeInTheDocument();
  });

  it("falls back to expiresAt as the period end when the key has no paidUntil", async () => {
    await renderWithStatus(
      statusJson({
        enterprise: false,
        state: "expired",
        paidUntil: null,
        expiresAt: new Date("2026-05-31T00:00:00.000Z").toISOString(),
        daysRemaining: 0,
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your license period ended on May 31, 2026."
    );
  });

  describe("seat-pressure banner", () => {
    it("shows a factual over-cap banner with quote CTAs and no red styling", async () => {
      await renderWithStatus(statusJson({ seatsUsed: 11, maxUsers: 10 }));
      const banner = screen.getByRole("alert");
      expect(banner).toHaveTextContent("You're using 11 of 10 licensed seats.");
      expect(banner).toHaveTextContent("Grace seats keep a new hire from waiting on procurement.");
      expect(banner.className).not.toContain("destructive");
      expect(banner.className).not.toContain("bg-amber");
      expect(screen.getByRole("link", { name: /email us for a quote/i })).toHaveAttribute(
        "href",
        "mailto:sales@heypinchy.com?subject=Pinchy%20seats%20quote%20request"
      );
      expect(screen.getByRole("link", { name: /book a call/i })).toHaveAttribute(
        "href",
        "https://calendly.com/clemenshelm/pinchy-demo"
      );
    });

    it("does not show the seat banner at exactly 100%", async () => {
      await renderWithStatus(statusJson({ seatsUsed: 10, maxUsers: 10 }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("does not show the seat banner when the license is inactive", async () => {
      await renderWithStatus(
        statusJson({ enterprise: false, state: "expired", seatsUsed: 11, maxUsers: 10 })
      );
      // The expired banner shows, but no seat banner on top.
      expect(screen.queryByText(/licensed seats/i)).not.toBeInTheDocument();
    });
  });

  describe("session dismissal", () => {
    it("hides the banner for the session when dismissed", async () => {
      const user = userEvent.setup();
      await renderWithStatus(statusJson({ state: "trial", type: "trial", daysRemaining: 23 }));
      expect(screen.getByRole("alert")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(sessionStorage.getItem("pinchy-banner-dismissed:license:trial")).toBe("1");
    });

    it("stays hidden on re-render within the same session", async () => {
      sessionStorage.setItem("pinchy-banner-dismissed:license:trial", "1");
      await renderWithStatus(statusJson({ state: "trial", type: "trial", daysRemaining: 23 }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("re-appears when the license state changes", async () => {
      sessionStorage.setItem("pinchy-banner-dismissed:license:trial", "1");
      await renderWithStatus(
        statusJson({
          enterprise: false,
          state: "trial-expired",
          type: "trial",
          daysRemaining: 0,
          expiresAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
        })
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("dismisses the seat banner independently of the license banner", async () => {
      const user = userEvent.setup();
      await renderWithStatus(
        statusJson({
          state: "trial",
          type: "trial",
          daysRemaining: 23,
          seatsUsed: 11,
          maxUsers: 10,
        })
      );
      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(2);

      const seatBanner = alerts.find((a) => a.textContent?.includes("licensed seats"))!;
      const dismiss = seatBanner.querySelector("button")!;
      await user.click(dismiss);

      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent(/Trial:/);
      expect(sessionStorage.getItem("pinchy-banner-dismissed:seats")).toBe("1");
    });
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

      // Flush any microtasks the visibility handler may have scheduled —
      // a stray re-fetch would land on the microtask queue, not after a
      // real wall-clock delay. Several rounds in case the handler chains
      // multiple awaits before reaching `fetch(...)`.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
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
