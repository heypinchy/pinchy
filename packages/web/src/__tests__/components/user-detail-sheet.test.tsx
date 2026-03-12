import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UserDetailSheet } from "@/components/user-detail-sheet";
import type { UserListItem } from "@/lib/user-list";

vi.mock("@/lib/enterprise", () => ({
  // Client component — mock at fetch level instead
}));

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

  it("should hide groups section when not enterprise", () => {
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
    expect(screen.queryByRole("checkbox", { name: /engineering/i })).not.toBeInTheDocument();
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
});
