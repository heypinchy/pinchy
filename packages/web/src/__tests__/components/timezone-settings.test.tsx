import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TimezoneSettings, getSupportedTimezones } from "@/components/timezone-settings";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// 30s timeout: the Select renders ~418 Intl.supportedValuesOf timezones, so
// opening it and querying options by role in jsdom takes ~3.5s of real CPU per
// interaction test — over the 5s default when the full suite contends for CPU.
describe("TimezoneSettings", { timeout: 30_000 }, () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders after fetching settings from /api/settings", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ key: "org.timezone", value: "UTC" }],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/settings");
  });

  it("renders a Save button", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });
  });

  it("shows Europe/Vienna timezone option in the dropdown", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ key: "org.timezone", value: "UTC" }],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    // Open the dropdown to verify timezones are available
    await userEvent.click(screen.getByRole("combobox"));
    // Find the Europe/Vienna option by its text content
    await waitFor(() => {
      expect(screen.getByText("Europe/Vienna")).toBeInTheDocument();
    });
  });

  it("POSTs the saved timezone to /api/settings when Save is clicked", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ key: "org.timezone", value: "UTC" }],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    // Open dropdown and select a different timezone
    await userEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: "Europe/Vienna" });
    await userEvent.click(option);

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenLastCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "org.timezone", value: "Europe/Vienna" }),
        })
      );
    });
  });

  it("POSTs the current timezone (UTC default) to /api/settings when no org.timezone setting exists", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenLastCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "org.timezone", value: "UTC" }),
        })
      );
    });
  });

  it("shows success toast after saving", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ key: "org.timezone", value: "UTC" }],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Settings saved");
    });
  });

  it("shows inline error when save fails", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ key: "org.timezone", value: "UTC" }],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid timezone" }),
    } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid timezone")).toBeInTheDocument();
    });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not throw an unhandled rejection and falls back to UTC when the preload fetch fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network down"));

      render(<TimezoneSettings />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      });

      // Let any pending microtasks / unhandled rejections surface.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The failed preload must leave the component on the sane UTC default,
      // provable through the payload it POSTs on Save.
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenLastCalledWith(
          "/api/settings",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ key: "org.timezone", value: "UTC" }),
          })
        );
      });
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });

  it("does not throw and falls back to UTC when /api/settings returns an unexpected (non-array) shape", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      render(<TimezoneSettings />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenLastCalledWith(
          "/api/settings",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ key: "org.timezone", value: "UTC" }),
          })
        );
      });
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });

  it("getSupportedTimezones falls back to ['UTC'] when the runtime lacks Intl.supportedValuesOf", () => {
    const original = Intl.supportedValuesOf;
    try {
      // Simulate an older runtime (pre-ES2022) where the API is absent, so the
      // "use client" module can't throw at import time.
      (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
      expect(getSupportedTimezones()).toEqual(["UTC"]);
    } finally {
      Intl.supportedValuesOf = original;
    }
  });

  it("shows fallback inline error when save fails without message", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<TimezoneSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to save timezone")).toBeInTheDocument();
    });
  });
});
