"use client";

import { useCallback } from "react";
import { useSearchParams, usePathname } from "next/navigation";

export const SETTINGS_TABS = [
  "context",
  "profile",
  "telegram",
  "support",
  "provider",
  "users",
  "groups",
  "apikeys",
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
  "automations",
  "diagnostics",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type AgentSettingsTab = (typeof AGENT_SETTINGS_TABS)[number];

/**
 * Syncs the active tab with the `?tab=` URL search parameter.
 * Validates the URL param against the provided set of valid tabs.
 * Falls back to `defaultTab` when the param is missing or invalid.
 *
 * The URL is the only source. Both settings pages render dynamically, so
 * `useSearchParams()` already holds the real query during SSR. A tab handed
 * down from the server render would go stale (#1271): `router.refresh()`
 * re-renders that page without remounting it, and Back can replay a cached
 * render, so the server's tab can describe a URL the user has since left.
 *
 * The third return value, `isExplicit`, is true when the resolved tab
 * came from an explicit (valid) `?tab=` param rather than the fallback
 * default. Consumers that need to distinguish "no selection yet" from
 * "the default tab was explicitly selected" (e.g. a mobile drill-down
 * menu) should pass `keepParamForDefault: true` so selecting the
 * default tab still writes `?tab=<default>` instead of clearing it.
 *
 * `setTab` pushes a history entry. The tab lives in the URL, which makes
 * each tab an addressable location, so Back walks back through the tabs
 * the user visited — on desktop laterally, and on a mobile drill-down out
 * to the menu level. Call it only for user-initiated switches; a
 * programmatic normalisation of the URL belongs in a `replaceState`.
 *
 * It writes history with the browser's own `pushState`, never
 * `router.push` (#1271). A router navigation to a new `?tab=` re-renders the
 * page on the server, and the click waits for that round trip — about three
 * seconds per switch on staging. Next.js syncs a native `pushState` into
 * `useSearchParams` and restores it on Back, with no round trip.
 */
export function useTabParam<T extends string>(
  defaultTab: T,
  validTabs: readonly T[],
  options?: { keepParamForDefault?: boolean }
): readonly [T, (tab: string) => void, boolean] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const keepParamForDefault = options?.keepParamForDefault ?? false;

  const rawTab = searchParams.get("tab") as T | null;
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
      const url = query ? `${pathname}?${query}` : pathname;
      // Every tab is its own URL, so every switch is its own history entry
      // and Back returns to the tab the user came from (#951). Radix asks for
      // the same tab twice per click (mousedown, then focus); router.push
      // dropped the repeat, a native pushState would add a second entry.
      if (url === `${window.location.pathname}${window.location.search}`) return;
      window.history.pushState(null, "", url);
    },
    [defaultTab, keepParamForDefault, pathname, searchParams, validTabs]
  );

  return [tab, setTab, isExplicit] as const;
}
