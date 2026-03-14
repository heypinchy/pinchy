import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { EnterpriseBanner } from "@/components/enterprise-banner";

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
});
