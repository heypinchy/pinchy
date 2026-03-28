"use client";

import { useCallback } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";

export const SETTINGS_TABS = [
  "context",
  "profile",
  "telegram",
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
  "telegram",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type AgentSettingsTab = (typeof AGENT_SETTINGS_TABS)[number];

/**
 * Syncs the active tab with the `?tab=` URL search parameter.
 * Validates the URL param against the provided set of valid tabs.
 * Falls back to `defaultTab` when the param is missing or invalid.
 *
 * Accepts an optional `initialTab` from server-side searchParams to
 * avoid SSR/hydration flicker. Falls back to useSearchParams() for
 * client-side navigation.
 */
export function useTabParam<T extends string>(
  defaultTab: T,
  validTabs: readonly T[],
  initialTab?: string | null
): [T, (tab: string) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const urlTab = (searchParams.get("tab") ?? initialTab ?? null) as T | null;
  const tab = urlTab && validTabs.includes(urlTab) ? urlTab : defaultTab;

  const setTab = useCallback(
    (newTab: string) => {
      if (!validTabs.includes(newTab as T)) return;

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
