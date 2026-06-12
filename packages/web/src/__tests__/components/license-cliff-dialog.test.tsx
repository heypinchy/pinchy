import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { LicenseCliffDialog } from "@/components/license-cliff-dialog";

function renderDialog(props: Partial<Parameters<typeof LicenseCliffDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(
    <LicenseCliffDialog
      open={true}
      onOpenChange={onOpenChange}
      feature="Groups"
      description="Control which users can access which agents."
      campaign="groups"
      licenseState="community"
      periodEnd={null}
      {...props}
    />
  );
  return { onOpenChange };
}

describe("LicenseCliffDialog", () => {
  it("offers the free trial first for community instances", () => {
    renderDialog();
    expect(screen.getByText(/Groups is included in Pinchy Pro/i)).toBeInTheDocument();
    expect(screen.getByText("Control which users can access which agents.")).toBeInTheDocument();
    expect(screen.getByText("30 days, no credit card, key by email.")).toBeInTheDocument();

    const trial = screen.getByRole("link", { name: /start free 30-day trial/i });
    expect(trial).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups#trial"
    );
    const pricing = screen.getByRole("link", { name: /see pricing/i });
    expect(pricing).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups"
    );
  });

  it("uses the visibility campaign for the access-control cliff", () => {
    renderDialog({ feature: "Access Control", campaign: "visibility" });
    expect(screen.getByRole("link", { name: /start free 30-day trial/i })).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=visibility#trial"
    );
  });

  it("shows pricing without a re-trial offer after an expired trial", () => {
    renderDialog({
      licenseState: "trial-expired",
      periodEnd: "2026-06-01T00:00:00.000Z",
    });
    expect(
      screen.getByText("Your trial ended on Jun 1, 2026. Your configuration is preserved.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /start free/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups"
    );
  });

  it("points an expired paid license at the customer portal", () => {
    renderDialog({
      licenseState: "expired",
      periodEnd: "2026-05-01T00:00:00.000Z",
    });
    expect(
      screen.getByText(
        "Your license period ended on May 1, 2026. Existing access restrictions remain enforced; management features are locked."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /renew/i })).toHaveAttribute(
      "href",
      "https://buy.heypinchy.com/my?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups"
    );
  });

  it("dismisses with a plain 'Not now'", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
