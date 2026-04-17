import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TimezoneSettings } from "@/components/timezone-settings";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("TimezoneSettings", () => {
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
