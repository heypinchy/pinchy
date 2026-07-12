"use client";

import { useCallback } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";

export const SETTINGS_TABS = [
  "context",
  "profile",
  "telegram",
  "support",
  "provider",
  "users",
  "groups",
  "integrations",
  "organization",
  "license",
  "security",
] as const;

export const AGENT_SETTINGS_TABS = [
  "general",
  "personality",
  "instructions",
  "permissions",
  "access",
  "telegram",
  "diagnostics",
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
 *
 * The third return value, `isExplicit`, is true when the resolved tab
 * came from an explicit (valid) `?tab=` param rather than the fallback
 * default. Consumers that need to distinguish "no selection yet" from
 * "the default tab was explicitly selected" (e.g. a mobile drill-down
 * menu) should pass `keepParamForDefault: true` so selecting the
 * default tab still writes `?tab=<default>` instead of clearing it.
 */
export function useTabParam<T extends string>(
  defaultTab: T,
  validTabs: readonly T[],
  initialTab?: string | null,
  options?: { keepParamForDefault?: boolean }
): readonly [T, (tab: string) => void, boolean] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const keepParamForDefault = options?.keepParamForDefault ?? false;

  const rawTab = (searchParams.get("tab") ?? initialTab ?? null) as T | null;
  const isExplicit = Boolean(rawTab && validTabs.includes(rawTab));
  const tab = isExplicit ? (rawTab as T) : defaultTab;

  const setTab = useCallback(
    (newTab: string) => {
      if (!validTabs.includes(newTab as T)) return;

      const params = new URLSearchParams(searchParams.toString());
      if (newTab === defaultTab && !keepParamForDefault) {
        params.delete("tab");
      } else {
        params.set("tab", newTab);
      }

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [defaultTab, keepParamForDefault, pathname, router, searchParams, validTabs]
  );

  return [tab, setTab, isExplicit] as const;
}
