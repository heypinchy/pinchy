import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { SettingsSecurity } from "@/components/settings-security";

describe("SettingsSecurity", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    mockRefresh.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows lock button when on HTTPS with no domain set", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          domain: null,
          currentHost: "pinchy.example.com",
          isHttps: true,
        })
      )
    );

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /lock pinchy\.example\.com & restart/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/accessing Pinchy via/)).toBeInTheDocument();
  });

  it("shows instructions when not on HTTPS (button disabled)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          domain: null,
          currentHost: null,
          isHttps: false,
        })
      )
    );

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(screen.getByText(/not secured with HTTPS/i)).toBeInTheDocument();
    });

    const lockButton = screen.getByRole("button", {
      name: /lock this domain/i,
    });
    expect(lockButton).toBeDisabled();
    expect(screen.getByText(/read the setup guide/i)).toBeInTheDocument();
  });

  it("shows locked status when domain is set", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          domain: "pinchy.example.com",
          currentHost: "pinchy.example.com",
          isHttps: true,
        })
      )
    );

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(screen.getByText(/locked to/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/pinchy\.example\.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove domain lock/i })).toBeInTheDocument();
  });

  it("shows restart overlay after locking domain", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            domain: null,
            currentHost: "pinchy.example.com",
            isHttps: true,
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ domain: "pinchy.example.com", restart: true }))
      );

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /lock pinchy\.example\.com & restart/i })
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole("button", { name: /lock pinchy\.example\.com & restart/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/applying security settings/i)).toBeInTheDocument();
    });
  });

  it("shows restart overlay after removing domain lock", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            domain: "pinchy.example.com",
            currentHost: "pinchy.example.com",
            isHttps: true,
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: true, restart: true })));

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove domain lock/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /remove domain lock/i }));

    await userEvent.click(screen.getByRole("button", { name: /remove lock & restart/i }));

    await waitFor(() => {
      expect(screen.getByText(/applying security settings/i)).toBeInTheDocument();
    });
  });

  it("shows error message when fetch fails", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });

  it("calls POST on lock", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            domain: null,
            currentHost: "pinchy.example.com",
            isHttps: true,
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ domain: "pinchy.example.com" })));

    render(<SettingsSecurity />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /lock pinchy\.example\.com & restart/i })
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole("button", { name: /lock pinchy\.example\.com & restart/i })
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/domain", {
        method: "POST",
      });
    });
  });
});
