"use client";

import { usePathname } from "next/navigation";
import { BottomTabBar } from "@/components/bottom-tab-bar";

interface AppShellProps {
  isAdmin: boolean;
  children: React.ReactNode;
}

export function AppShell({ isAdmin, children }: AppShellProps) {
  const pathname = usePathname();
  const isChatView = pathname.startsWith("/chat/");
  const showTabBar = !isChatView;

  return (
    <div className={`flex flex-col h-full min-h-0 ${showTabBar ? "pb-14 md:pb-0" : ""}`}>
      <div className={showTabBar ? "flex-1 overflow-y-auto" : "flex-1 min-h-0"}>{children}</div>
      {showTabBar && <BottomTabBar currentPath={pathname} isAdmin={isAdmin} />}
    </div>
  );
}
