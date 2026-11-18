// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LogoutButton } from "@/components/logout-button";

const { mockLeaveAccount } = vi.hoisted(() => ({ mockLeaveAccount: vi.fn() }));
vi.mock("@/lib/account-switch", () => ({
  leaveAccount: (...args: unknown[]) => mockLeaveAccount(...args),
}));

describe("LogoutButton", () => {
  it("leaves the account, so the next person on this browser starts clean (#1286)", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <LogoutButton />
      </SidebarProvider>
    );

    await user.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(mockLeaveAccount).toHaveBeenCalledTimes(1));
  });
});
