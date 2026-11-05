"use client";

import { LogOut } from "lucide-react";
import { leaveAccount } from "@/lib/account-switch";
import { SidebarMenuButton } from "@/components/ui/sidebar";

export function LogoutButton() {
  return (
    <SidebarMenuButton onClick={() => leaveAccount()}>
      <LogOut className="size-4" />
      <span>Log out</span>
    </SidebarMenuButton>
  );
}
