"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { SidebarMenuButton } from "@/components/ui/sidebar";

export function LogoutButton() {
  return (
    <SidebarMenuButton onClick={() => signOut({ callbackUrl: "/login" })}>
      <LogOut className="size-4" />
      <span>Log out</span>
    </SidebarMenuButton>
  );
}
