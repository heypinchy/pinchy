"use client";

import { useCallback, useState } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";

/**
 * Syncs the active tab with the `?tab=` URL search parameter.
 * Falls back to `defaultTab` when no param is present.
 * Removes the param when switching back to the default tab (clean URLs).
 */
export function useTabParam(defaultTab: string): [string, (tab: string) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const urlTab = searchParams.get("tab");
  const [tab, setTabState] = useState(urlTab ?? defaultTab);

  const setTab = useCallback(
    (newTab: string) => {
      setTabState(newTab);

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
    [defaultTab, pathname, router, searchParams]
  );

  return [tab, setTab];
}
