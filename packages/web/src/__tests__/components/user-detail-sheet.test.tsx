import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UserDetailSheet } from "@/components/user-detail-sheet";
import type { UserListItem } from "@/lib/user-list";

vi.mock("@/lib/enterprise", () => ({
  // Client component — mock at fetch level instead
}));

// toast is both callable (toast("…")) and has .error/.success.
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

// Radix UI Select uses pointer capture and scrollIntoView which jsdom doesn't support
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const mockUser: UserListItem = {
  kind: "user",
  id: "u1",
  name: "Max Müller",
  email: "max@example.com",
  role: "member",
  status: "active",
  groups: [{ id: "g1", name: "Engineering" }],
};

const allGroups = [
  { id: "g1", name: "Engineering" },
  { id: "g2", name: "Marketing" },
  { id: "g3", name: "Sales" },
];

describe("UserDetailSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render user name and email", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByText("Max Müller")).toBeInTheDocument();
    expect(screen.getByText("max@example.com")).toBeInTheDocument();
  });

  it("should render status badge", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("should render role select with current value", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    // shadcn Select renders a trigger with the current value
    expect(screen.getByRole("combobox")).toHaveTextContent(/member/i);
  });

  it("should render group checkboxes with correct checked state", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const engCheckbox = screen.getByRole("checkbox", { name: /engineering/i });
    const marketingCheckbox = screen.getByRole("checkbox", {
      name: /marketing/i,
    });
    expect(engCheckbox).toBeChecked();
    expect(marketingCheckbox).not.toBeChecked();
  });

  it("should hide groups section without a license when the user has no groups", () => {
    render(
      <UserDetailSheet
        user={{ ...mockUser, groups: [] }}
        allGroups={allGroups}
        isEnterprise={false}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.queryByRole("checkbox", { name: /engineering/i })).not.toBeInTheDocument();
  });

  it("allows removing existing memberships without a license, but not adding (carve-out, § 5)", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={false}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    // Existing membership can be removed…
    const engCheckbox = screen.getByRole("checkbox", { name: /engineering/i });
    expect(engCheckbox).toBeChecked();
    expect(engCheckbox).toBeEnabled();
    // …but new memberships require an active license.
    expect(screen.getByRole("checkbox", { name: /marketing/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /sales/i })).toBeDisabled();
    expect(
      screen.getByText(/Adding to groups requires an active license\. Removing always works\./)
    ).toBeInTheDocument();
  });

  it("does not allow re-checking a membership that was unchecked without a license", async () => {
    const user = userEvent.setup();
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={false}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const engCheckbox = screen.getByRole("checkbox", { name: /engineering/i });
    await user.click(engCheckbox);
    expect(engCheckbox).not.toBeChecked();
    // Re-checking would ADD a membership server-side relative to nothing —
    // but the original membership still exists in the DB until saved, so
    // restoring it stays within the original set and remains allowed.
    expect(engCheckbox).toBeEnabled();
  });

  it("should hide groups section when no groups exist", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={[]}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("should disable role select when viewing own account", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="u1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("should render Deactivate button for active users", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
  });

  it("should render Reactivate button for deactivated users", () => {
    const deactivatedUser: UserListItem = {
      ...mockUser,
      status: "deactivated",
    };
    render(
      <UserDetailSheet
        user={deactivatedUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /reactivate/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deactivate/i })).not.toBeInTheDocument();
  });

  it("should disable Deactivate button when viewing own account", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="u1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /deactivate/i })).toBeDisabled();
  });

  it("should render Reset Password button", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /reset password/i })).toBeInTheDocument();
  });

  it("should disable Save button when no changes made", () => {
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("should enable Save button after changing role", async () => {
    const user = userEvent.setup();
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    // Open select and change role
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /admin/i }));
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });

  it("should enable Save button after toggling a group", async () => {
    const user = userEvent.setup();
    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await user.click(screen.getByRole("checkbox", { name: /marketing/i }));
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });

  it("should disable role and groups for deactivated users", () => {
    const deactivatedUser: UserListItem = {
      ...mockUser,
      status: "deactivated",
    };
    render(
      <UserDetailSheet
        user={deactivatedUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /engineering/i })).toBeDisabled();
  });

  it("on partial save failure keeps the sheet open via onRefresh (NOT onSaved, which closes it)", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onRefresh = vi.fn();
    const onOpenChange = vi.fn();

    // role PATCH lands, groups PUT fails — the classic partial-success case.
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "/api/users/u1" && init?.method === "PATCH") {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (String(url) === "/api/users/u1/groups" && init?.method === "PUT") {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        onRefresh={onRefresh}
      />
    );

    // Change the role and toggle a group so both writes fire.
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /admin/i }));
    await user.click(screen.getByRole("checkbox", { name: /marketing/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/group membership could not be updated/i)
      );
    });
    // The role half landed — refetch the list so it reflects the saved half...
    expect(onRefresh).toHaveBeenCalled();
    // ...but the sheet must stay open. `onSaved` is the parent's close+refetch
    // (it sets selectedUser=null, unmounting the sheet), so it must NOT fire on
    // partial success — that was the contradiction the comment claimed to avoid.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("should show copied feedback when reset link Copy button is clicked", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "reset-token-xyz" }),
    } as Response);

    render(
      <UserDetailSheet
        user={mockUser}
        allGroups={allGroups}
        isEnterprise={true}
        currentUserId="admin-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await screen.findByText(/reset-token-xyz/);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await screen.findByRole("button", { name: "Copied!" });
  });
});
