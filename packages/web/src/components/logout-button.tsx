"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { SidebarMenuButton } from "@/components/ui/sidebar";

export function LogoutButton() {
  const router = useRouter();

  return (
    <SidebarMenuButton
      onClick={async () => {
        await authClient.signOut();
        router.push("/login");
      }}
    >
      <LogOut className="size-4" />
      <span>Log out</span>
    </SidebarMenuButton>
  );
}
