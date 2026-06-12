import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsLicense } from "@/components/settings-license";

const noLicenseStatus = {
  enterprise: false,
  type: null,
  org: null,
  expiresAt: null,
  daysRemaining: null,
  managedByEnv: false,
  maxUsers: 0,
  seatsUsed: 0,
};

const statusOkResponse = (data: object) =>
  ({
    ok: true,
    json: async () => data,
  }) as Response;

describe("SettingsLicense", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    // Default: status fetch returns no-license (used by tests without initialLicense)
    fetchSpy.mockResolvedValue(statusOkResponse(noLicenseStatus));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows loading state initially when no initialLicense provided", () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        enterprise: false,
        type: null,
        org: null,
        expiresAt: null,
        daysRemaining: null,
        managedByEnv: false,
        maxUsers: 0,
        seatsUsed: 0,
      }),
    } as Response);
    render(<SettingsLicense />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows no-license state when enterprise is false", async () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          type: null,
          org: null,
          expiresAt: null,
          daysRemaining: null,
          managedByEnv: false,
          maxUsers: 0,
          seatsUsed: 0,
        }}
      />
    );
    expect(screen.getByText(/no active license key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/license key/i)).toBeInTheDocument();
  });

  it("links community instances to the pricing page with settings UTM", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          state: "community",
          type: null,
          org: null,
          expiresAt: null,
          paidUntil: null,
          daysRemaining: null,
          managedByEnv: false,
          maxUsers: 0,
          seatsUsed: 0,
          hasGatedConfig: false,
        }}
      />
    );
    const link = screen.getByRole("link", { name: /see pricing/i });
    expect(link).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=settings-license&utm_campaign=pro-10"
    );
  });

  it("shows the license period end for paid keys with paidUntil", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          state: "paid",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2027-02-01T00:00:00Z",
          paidUntil: "2027-01-01T00:00:00Z",
          daysRemaining: 235,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: false,
        }}
      />
    );
    expect(
      screen.getByText(/License period ends Jan 1, 2027\. Grace until Feb 1, 2027\./)
    ).toBeInTheDocument();
  });

  it("shows the grace copy and a renew link during grace", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          state: "grace",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2026-07-01T00:00:00Z",
          paidUntil: "2026-06-01T00:00:00Z",
          daysRemaining: 19,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: false,
        }}
      />
    );
    expect(
      screen.getByText(/License period ended Jun 1, 2026\. Grace until Jul 1, 2026\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /renew/i })).toHaveAttribute(
      "href",
      "https://buy.heypinchy.com/my?utm_source=pinchy-app&utm_medium=settings-license&utm_campaign=pro-10"
    );
  });

  it("shows the expired copy with a renew link for an expired paid key", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          state: "expired",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2026-05-31T00:00:00Z",
          paidUntil: "2026-05-01T00:00:00Z",
          daysRemaining: 0,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: true,
        }}
      />
    );
    expect(
      screen.getByText(
        /Your license period ended on May 1, 2026\. Existing access restrictions remain enforced; management features are locked\./
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /renew/i })).toBeInTheDocument();
    // A new key can be entered right here.
    expect(screen.getByLabelText(/license key/i)).toBeInTheDocument();
  });

  it("offers the audited escape hatch when the license is inactive and gated config exists", async () => {
    const user = userEvent.setup();
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          state: "expired",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2026-05-31T00:00:00Z",
          paidUntil: "2026-05-01T00:00:00Z",
          daysRemaining: 0,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: true,
        }}
      />
    );
    const button = screen.getByRole("button", { name: /remove all license-gated configuration/i });
    await user.click(button);

    // Confirmation explains exactly what happens — this deliberately widens access.
    expect(screen.getByText(/deletes all groups/i)).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit log/i)).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ groupsRemoved: 2, agentsReset: 1 }),
    } as Response);

    await user.click(screen.getByRole("button", { name: /remove configuration/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/enterprise/gated-config",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  it("hides the escape hatch when no gated config exists", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          state: "expired",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2026-05-31T00:00:00Z",
          paidUntil: "2026-05-01T00:00:00Z",
          daysRemaining: 0,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: false,
        }}
      />
    );
    expect(
      screen.queryByRole("button", { name: /remove all license-gated configuration/i })
    ).not.toBeInTheDocument();
  });

  it("hides the escape hatch while the license is active", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          state: "paid",
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2027-02-01T00:00:00Z",
          paidUntil: "2027-01-01T00:00:00Z",
          daysRemaining: 235,
          managedByEnv: false,
          maxUsers: 10,
          seatsUsed: 3,
          hasGatedConfig: true,
        }}
      />
    );
    expect(
      screen.queryByRole("button", { name: /remove all license-gated configuration/i })
    ).not.toBeInTheDocument();
  });

  it("shows the trial-expired copy with a pricing link", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: false,
          state: "trial-expired",
          type: "trial",
          org: "Acme Corp",
          expiresAt: "2026-06-01T00:00:00Z",
          paidUntil: null,
          daysRemaining: 0,
          managedByEnv: false,
          maxUsers: 50,
          seatsUsed: 3,
          hasGatedConfig: false,
        }}
      />
    );
    expect(
      screen.getByText(/Your trial ended on Jun 1, 2026\. Your configuration is preserved\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute(
      "href",
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=settings-license&utm_campaign=pro-10"
    );
  });

  it("shows license info when enterprise is true", async () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          type: "paid",
          org: "Acme Corp",
          expiresAt: "2027-01-01T00:00:00Z",
          daysRemaining: 365,
          managedByEnv: false,
          maxUsers: 0,
          seatsUsed: 0,
        }}
      />
    );
    expect(screen.getByText(/acme corp/i)).toBeInTheDocument();
    expect(screen.getByText(/365 days remaining/i)).toBeInTheDocument();
    expect(screen.getByText(/paid/i)).toBeInTheDocument();
  });

  it("shows trial badge for trial license", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          type: "trial",
          org: null,
          expiresAt: null,
          daysRemaining: null,
          managedByEnv: false,
          maxUsers: 0,
          seatsUsed: 0,
        }}
      />
    );
    expect(screen.getByText(/trial/i)).toBeInTheDocument();
  });

  it("hides Update Key button when managedByEnv is true", () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          type: "paid",
          org: "Acme Corp",
          expiresAt: null,
          daysRemaining: null,
          managedByEnv: true,
          maxUsers: 0,
          seatsUsed: 0,
        }}
      />
    );
    expect(screen.queryByRole("button", { name: /update key/i })).not.toBeInTheDocument();
    expect(screen.getByText(/PINCHY_ENTERPRISE_KEY/)).toBeInTheDocument();
  });

  it("shows Update Key button when not managedByEnv", async () => {
    render(
      <SettingsLicense
        initialLicense={{
          enterprise: true,
          type: "paid",
          org: "Acme",
          expiresAt: null,
          daysRemaining: null,
          managedByEnv: false,
          maxUsers: 0,
          seatsUsed: 0,
        }}
      />
    );
    expect(screen.getByRole("button", { name: /update key/i })).toBeInTheDocument();
  });

  it("calls PUT /api/enterprise/key when save is clicked", async () => {
    fetchSpy.mockResolvedValueOnce(
      statusOkResponse({
        enterprise: true,
        type: "paid",
        org: null,
        expiresAt: null,
        daysRemaining: null,
        managedByEnv: false,
        maxUsers: 0,
        seatsUsed: 0,
      })
    );

    render(<SettingsLicense initialLicense={noLicenseStatus} />);

    await userEvent.type(screen.getByLabelText(/license key/i), "eyJvalid");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/enterprise/key",
        expect.objectContaining({ method: "PUT" })
      )
    );
  });

  it("shows error message when save fails", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid license key" }),
    } as Response);

    render(<SettingsLicense initialLicense={noLicenseStatus} />);

    await userEvent.type(screen.getByLabelText(/license key/i), "eyJinvalid");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/invalid license key/i)).toBeInTheDocument());
  });

  it("calls onEnterpriseActivated callback after successful activation", async () => {
    const onActivated = vi.fn();
    fetchSpy.mockResolvedValueOnce(
      statusOkResponse({
        enterprise: true,
        type: "paid",
        org: "Acme",
        expiresAt: null,
        daysRemaining: null,
        managedByEnv: false,
        maxUsers: 0,
        seatsUsed: 0,
      })
    );

    render(
      <SettingsLicense initialLicense={noLicenseStatus} onEnterpriseActivated={onActivated} />
    );

    await userEvent.type(screen.getByLabelText(/license key/i), "eyJvalid");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onActivated).toHaveBeenCalled());
  });

  it("shows seats line when maxUsers > 0", () => {
    const license = {
      enterprise: true,
      type: "paid",
      org: "TestCo",
      expiresAt: "2027-01-01T00:00:00Z",
      daysRemaining: 250,
      managedByEnv: false,
      maxUsers: 10,
      seatsUsed: 7,
    };
    render(<SettingsLicense initialLicense={license} />);
    expect(screen.getByText(/Seats: 7 \/ 10 used/)).toBeInTheDocument();
  });

  it("hides seats line when license is unlimited (maxUsers=0)", () => {
    const license = {
      enterprise: true,
      type: "trial",
      org: "TestCo",
      expiresAt: "2027-01-01T00:00:00Z",
      daysRemaining: 14,
      managedByEnv: false,
      maxUsers: 0,
      seatsUsed: 5,
    };
    render(<SettingsLicense initialLicense={license} />);
    expect(screen.queryByText(/Seats:/)).not.toBeInTheDocument();
  });

  it("does not refetch status when initialLicense is provided", () => {
    const license = {
      enterprise: true,
      type: "paid",
      org: "TestCo",
      expiresAt: null,
      daysRemaining: null,
      managedByEnv: false,
      maxUsers: 0,
      seatsUsed: 0,
    };
    render(<SettingsLicense initialLicense={license} />);
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/enterprise/status");
  });

  it("dispatches a 'license-updated' event after a successful save", async () => {
    fetchSpy.mockResolvedValueOnce(
      statusOkResponse({
        enterprise: true,
        type: "paid",
        org: "Acme",
        expiresAt: null,
        daysRemaining: null,
        managedByEnv: false,
        maxUsers: 0,
        seatsUsed: 0,
      })
    );
    const onLicenseUpdated = vi.fn();
    window.addEventListener("license-updated", onLicenseUpdated);

    render(<SettingsLicense initialLicense={noLicenseStatus} />);
    await userEvent.type(screen.getByLabelText(/license key/i), "eyJvalid");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onLicenseUpdated).toHaveBeenCalled());
    window.removeEventListener("license-updated", onLicenseUpdated);
  });

  it("does not dispatch 'license-updated' when save fails", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid license key" }),
    } as Response);
    const onLicenseUpdated = vi.fn();
    window.addEventListener("license-updated", onLicenseUpdated);

    render(<SettingsLicense initialLicense={noLicenseStatus} />);
    await userEvent.type(screen.getByLabelText(/license key/i), "eyJbad");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/invalid license key/i)).toBeInTheDocument());
    expect(onLicenseUpdated).not.toHaveBeenCalled();
    window.removeEventListener("license-updated", onLicenseUpdated);
  });
});
