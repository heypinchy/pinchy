"use client";

import Link from "next/link";
import { BarChart3, Bot, Settings, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";

interface BottomTabBarProps {
  currentPath: string;
  isAdmin: boolean;
}

const tabs = [
  {
    label: "Agents",
    href: "/agents",
    icon: Bot,
    isActive: (path: string) => path === "/agents" || path === "/",
    adminOnly: false,
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    isActive: (path: string) => path.startsWith("/settings"),
    adminOnly: false,
  },
  {
    label: "Usage",
    href: "/usage",
    icon: BarChart3,
    isActive: (path: string) => path.startsWith("/usage"),
    adminOnly: true,
  },
  {
    label: "Audit",
    href: "/audit",
    icon: ClipboardList,
    isActive: (path: string) => path.startsWith("/audit"),
    adminOnly: true,
  },
];

export function BottomTabBar({ currentPath, isAdmin }: BottomTabBarProps) {
  const visibleTabs = tabs.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <nav
      role="navigation"
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex h-14 items-center justify-around">
        {visibleTabs.map((tab) => {
          const active = tab.isActive(currentPath);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1",
                active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" />
              <span className="text-xs">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
