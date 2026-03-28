import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsProfile } from "@/components/settings-profile";
import { toast } from "sonner";

const { mockRouterPush } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: mockRouterPush }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

  it("should show success toast after saving name", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Name updated");
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

  it("should show success toast after changing password", async () => {
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
      expect(toast.success).toHaveBeenCalledWith("Password updated");
    });
  });

  it("should clear password fields after successful password change", async () => {
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
      expect(screen.getByLabelText("Current Password")).toHaveValue("");
      expect(screen.getByLabelText("New Password")).toHaveValue("");
      expect(screen.getByLabelText("Confirm Password")).toHaveValue("");
    });
  });

  it("should show validation error when passwords do not match", async () => {
    const user = userEvent.setup();

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "oldpass123");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "different789");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(screen.getByText("Passwords don't match")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show validation error when name is empty", async () => {
    const user = userEvent.setup();

    render(<SettingsProfile userName="Alice" />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show inline error from API when saving name fails", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Name already taken" }),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Name already taken")).toBeInTheDocument();
    });
  });

  it("should show fallback inline error when saving name fails without message", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to update name")).toBeInTheDocument();
    });
  });

  it("should show inline error from API when changing password fails", async () => {
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

  it("should show fallback inline error when changing password fails without message", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    render(<SettingsProfile userName="Alice" />);

    await user.type(screen.getByLabelText("Current Password"), "wrongpass");
    await user.type(screen.getByLabelText("New Password"), "newpass456");
    await user.type(screen.getByLabelText("Confirm Password"), "newpass456");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to change password")).toBeInTheDocument();
    });
  });

  describe("onDirtyChange callback", () => {
    it("should call onDirtyChange(true) when name is changed from default", async () => {
      const user = userEvent.setup();
      const onDirtyChange = vi.fn();
      render(<SettingsProfile userName="Alice" onDirtyChange={onDirtyChange} />);

      const nameInput = screen.getByLabelText("Name");
      await user.clear(nameInput);
      await user.type(nameInput, "Bob");

      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it("should call onDirtyChange(true) when a password field is typed", async () => {
      const user = userEvent.setup();
      const onDirtyChange = vi.fn();
      render(<SettingsProfile userName="Alice" onDirtyChange={onDirtyChange} />);

      await user.type(screen.getByLabelText("Current Password"), "somepass");

      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it("should call onDirtyChange(false) after successful password change", async () => {
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const onDirtyChange = vi.fn();
      render(<SettingsProfile userName="Alice" onDirtyChange={onDirtyChange} />);

      await user.type(screen.getByLabelText("Current Password"), "oldpass123");
      await user.type(screen.getByLabelText("New Password"), "newpass456");
      await user.type(screen.getByLabelText("Confirm Password"), "newpass456");
      await user.click(screen.getByRole("button", { name: "Change Password" }));

      await waitFor(() => {
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      });
    });
  });

  it("should populate name field when userName prop arrives after initial empty render", () => {
    const { rerender } = render(<SettingsProfile userName="" />);

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveValue("");

    rerender(<SettingsProfile userName="Alice" />);

    expect(nameInput).toHaveValue("Alice");
  });

  it("should render a Log out button", () => {
    render(<SettingsProfile userName="Alice" />);

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("should call signOut and redirect when Log out is clicked", async () => {
    const user = userEvent.setup();
    const { authClient } = await import("@/lib/auth-client");

    render(<SettingsProfile userName="Alice" />);

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(authClient.signOut).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });
  });
});
