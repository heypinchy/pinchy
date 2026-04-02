import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { isSetupComplete } from "@/lib/setup";

export async function getDomain(): Promise<string | null> {
  return getSetting("domain");
}

export async function isInsecureMode(): Promise<boolean> {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) return false;
  const domain = await getDomain();
  return domain === null;
}

// In-memory cache for synchronous access from auth config.
// Updated at startup and whenever domain setting changes.
let cachedDomain: string | null | undefined = undefined; // undefined = not loaded yet

export async function loadDomainCache(): Promise<void> {
  cachedDomain = await getSetting("domain");
}

export function getCachedDomain(): string | null {
  // If cache hasn't been loaded yet, return null (safe default = insecure mode)
  return cachedDomain ?? null;
}

export async function setDomainAndRefreshCache(domain: string): Promise<void> {
  await setSetting("domain", domain);
  cachedDomain = domain;
}

export async function deleteDomainAndRefreshCache(): Promise<void> {
  await deleteSetting("domain");
  cachedDomain = null;
}

/** Reset cache to unloaded state — only for tests. */
export function _resetCacheForTests(): void {
  cachedDomain = undefined;
}
