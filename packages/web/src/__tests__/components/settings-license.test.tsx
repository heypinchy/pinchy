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
    const fetchSpy = vi.spyOn(global, "fetch");
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
});
