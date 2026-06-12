import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";

describe("EnterpriseFeatureCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows only a factual notice to non-admins (no sales copy)", () => {
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
  });

  it("never fetches — license info comes from the parent via props", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
        licenseState="community"
      />
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders feature name, description, and Pro badge for admins", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Manage team groups for access control."
        campaign="groups"
        isAdmin={true}
        licenseState="community"
      />
    );
    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Manage team groups for access control.")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });

  it("keeps the how-to-enable instructions for admins", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
        licenseState="community"
      />
    );
    expect(screen.getByText(/Settings → License/)).toBeInTheDocument();
    expect(screen.getByText("PINCHY_ENTERPRISE_KEY")).toBeInTheDocument();
  });

  it("opens the cliff dialog from the trial CTA on community instances", async () => {
    const user = userEvent.setup();
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
        licenseState="community"
      />
    );
    await user.click(screen.getByRole("button", { name: /start free 30-day trial/i }));

    expect(screen.getByText(/Groups is included in Pinchy Pro/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start free 30-day trial/i })).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups#trial"
    );

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/included in Pinchy Pro/i)).not.toBeInTheDocument();
  });

  it("labels the CTA 'See pricing' after an expired trial", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
        licenseState="trial-expired"
        periodEnd="2026-06-01T00:00:00.000Z"
      />
    );
    expect(screen.getByRole("button", { name: /see pricing/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start free/i })).not.toBeInTheDocument();
  });

  it("labels the CTA 'Renew' for an expired paid license", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
        licenseState="expired"
        periodEnd="2026-05-01T00:00:00.000Z"
      />
    );
    expect(screen.getByRole("button", { name: /renew/i })).toBeInTheDocument();
  });

  it("defaults to the community CTA when the parent provides no state", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Description here."
        campaign="groups"
        isAdmin={true}
      />
    );
    expect(screen.getByRole("button", { name: /start free 30-day trial/i })).toBeInTheDocument();
  });
});
