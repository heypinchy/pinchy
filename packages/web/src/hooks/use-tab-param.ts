"use client";

import { useCallback, useState } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";

export const SETTINGS_TABS = [
  "context",
  "profile",
  "provider",
  "users",
  "groups",
  "license",
] as const;

export const AGENT_SETTINGS_TABS = [
  "general",
  "personality",
  "instructions",
  "permissions",
  "access",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type AgentSettingsTab = (typeof AGENT_SETTINGS_TABS)[number];

/**
 * Syncs the active tab with the `?tab=` URL search parameter.
 * Validates the URL param against the provided set of valid tabs.
 * Falls back to `defaultTab` when the param is missing or invalid.
 * Removes the param when switching back to the default tab (clean URLs).
 */
export function useTabParam<T extends string>(
  defaultTab: T,
  validTabs: readonly T[]
): [T, (tab: string) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const urlTab = searchParams.get("tab") as T | null;
  const initialTab = urlTab && validTabs.includes(urlTab) ? urlTab : defaultTab;
  const [tab, setTabState] = useState<T>(initialTab);

  const setTab = useCallback(
    (newTab: string) => {
      if (!validTabs.includes(newTab as T)) return;
      setTabState(newTab as T);

      const params = new URLSearchParams(searchParams.toString());
      if (newTab === defaultTab) {
        params.delete("tab");
      } else {
        params.set("tab", newTab);
      }

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [defaultTab, pathname, router, searchParams, validTabs]
  );

  return [tab, setTab];
}
