import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";

function mockStatus(overrides: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      enterprise: false,
      state: "community",
      type: null,
      expiresAt: null,
      paidUntil: null,
      ...overrides,
    }),
  } as Response);
}

describe("EnterpriseFeatureCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows only a factual notice to non-admins (no sales copy, no fetch)", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Manage team groups for access control."
        campaign="groups"
        isAdmin={false}
      />
    );
    expect(
      screen.getByText("This feature requires a Pro license. Ask your administrator.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders feature name, description, and Pro badge for admins", async () => {
    mockStatus();
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Manage team groups for access control."
        campaign="groups"
        isAdmin={true}
      />
    );
    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Manage team groups for access control.")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it("keeps the how-to-enable instructions for admins", async () => {
    mockStatus();
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
      />
    );
    expect(screen.getByText(/Settings → License/)).toBeInTheDocument();
    expect(screen.getByText("PINCHY_ENTERPRISE_KEY")).toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it("opens the cliff dialog from the trial CTA on community instances", async () => {
    const user = userEvent.setup();
    mockStatus();
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
      />
    );
    const cta = await screen.findByRole("button", { name: /start free 30-day trial/i });
    await user.click(cta);

    expect(screen.getByText(/Groups is included in Pinchy Pro/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start free 30-day trial/i })).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups#trial"
    );

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/included in Pinchy Pro/i)).not.toBeInTheDocument();
  });

  it("labels the CTA 'See pricing' after an expired trial", async () => {
    mockStatus({ state: "trial-expired", type: "trial", expiresAt: "2026-06-01T00:00:00.000Z" });
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
      />
    );
    expect(await screen.findByRole("button", { name: /see pricing/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start free/i })).not.toBeInTheDocument();
  });

  it("labels the CTA 'Renew' for an expired paid license", async () => {
    mockStatus({
      state: "expired",
      type: "paid",
      paidUntil: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-31T00:00:00.000Z",
    });
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
      />
    );
    expect(await screen.findByRole("button", { name: /renew/i })).toBeInTheDocument();
  });
});
