import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";

describe("EnterpriseFeatureCard", () => {
  it("renders feature name and description", () => {
    render(
      <EnterpriseFeatureCard
        feature="Groups"
        description="Manage team groups for access control."
      />
    );

    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Manage team groups for access control.")).toBeInTheDocument();
  });

  it("shows Enterprise badge", () => {
    render(<EnterpriseFeatureCard feature="Groups" description="Description here." />);

    expect(screen.getByText("Enterprise")).toBeInTheDocument();
  });

  it("shows Learn more link to enterprise page", () => {
    render(<EnterpriseFeatureCard feature="Groups" description="Description here." />);

    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "https://heypinchy.com/enterprise");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
