import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsProfile } from "@/components/settings-profile";

vi.mock("next-auth/react", () => ({
  signOut: vi.fn(),
}));

describe("SettingsProfile", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render Name input pre-filled with current name", () => {
    render(<SettingsProfile userName="Alice" />);

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue("Alice");
  });

  it("should render a Save button for the name section", () => {
    render(<SettingsProfile userName="Alice" />);

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("should call PATCH /api/users/me when Save is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Bob");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      });
    });
  });

  it("should show success feedback after saving name", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Name updated successfully")).toBeInTheDocument();
    });
  });

  it("should render password change form", () => {
    render(<SettingsProfile userName="Alice" />);

    expect(screen.getByLabelText("Current Password")).toBeInTheDocument();
    expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change Password" })).toBeInTheDocument();
  });

  it("should call POST /api/users/me/password when Change Password is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "oldpass123");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "newpass456");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/users/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "oldpass123", newPassword: "newpass456" }),
      });
    });
  });

  it("should show success feedback after changing password", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "oldpass123");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "newpass456");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(screen.getByText("Password changed successfully")).toBeInTheDocument();
    });
  });

  it("should show error when passwords do not match", async () => {
    const user = userEvent.setup();

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "oldpass123");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "different789");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show error from API when saving name fails", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Name is required" }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });
  });

  it("should show error from API when changing password fails", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Current password is incorrect" }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "wrongpass");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "newpass456");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(screen.getByText("Current password is incorrect")).toBeInTheDocument();
    });
  });

  it("should render a Log out button", () => {
    render(<SettingsProfile userName="Alice" />);

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("should call signOut when Log out is clicked", async () => {
    const user = userEvent.setup();
    const { signOut } = await import("next-auth/react");

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
