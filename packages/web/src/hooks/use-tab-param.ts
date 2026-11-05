"use client";

import { useCallback, useState } from "react";
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
 *
 * `setTab` pushes a history entry. The tab lives in the URL, which makes
 * each tab an addressable location, so Back walks back through the tabs
 * the user visited — on desktop laterally, and on a mobile drill-down out
 * to the menu level. Call it only for user-initiated switches; a
 * programmatic normalisation of the URL belongs in a `replaceState`.
 *
 * It writes history with the browser's own `pushState`, never
 * `router.push` (#1271). The App Router keys a page segment by its search
 * params, so a router navigation to a new `?tab=` re-renders the server page
 * and remounts the whole tab set — every tab refetches and shows
 * "Loading..." on each switch. Next.js syncs a native `pushState` into
 * `useSearchParams` and restores it on Back, with no round trip.
 */
export function useTabParam<T extends string>(
  defaultTab: T,
  validTabs: readonly T[],
  initialTab?: string | null,
  options?: { keepParamForDefault?: boolean }
): readonly [T, (tab: string) => void, boolean] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const keepParamForDefault = options?.keepParamForDefault ?? false;

  // initialTab is the server render's view of the URL, and tab switches no
  // longer re-run that render (see below), so the prop never updates. Only
  // trust it while the URL is still the one the page was rendered for;
  // otherwise a URL without `?tab=` would fall back to the first tab opened.
  const search = searchParams.toString();
  const [searchAtMount] = useState(search);
  const fallbackTab = search === searchAtMount ? initialTab : null;
  const rawTab = (searchParams.get("tab") ?? fallbackTab ?? null) as T | null;
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
