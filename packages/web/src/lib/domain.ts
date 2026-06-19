import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { isSetupComplete } from "@/lib/setup";
import { setCachedDomain } from "@/lib/domain-cache";
import { writeDomainLockFlag } from "@/lib/secure-cookies";

// Re-export synchronous cache reader so existing consumers don't break.
export { getCachedDomain, _resetCacheForTests } from "@/lib/domain-cache";

export async function getDomain(): Promise<string | null> {
  return getSetting("domain");
}

export async function isInsecureMode(): Promise<boolean> {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) return false;
  const domain = await getDomain();
  return domain === null;
}

export async function loadDomainCache(): Promise<void> {
  const domain = await getSetting("domain");
  setCachedDomain(domain);
  // Backfill the sync flag the secure-cookie decision reads at import. Keeps
  // already-locked installs (which predate the flag file) in step on boot.
  writeDomainLockFlag(domain);
}

export async function setDomainAndRefreshCache(domain: string): Promise<void> {
  await setSetting("domain", domain);
  setCachedDomain(domain);
  writeDomainLockFlag(domain);
}

export async function deleteDomainAndRefreshCache(): Promise<void> {
  await deleteSetting("domain");
  setCachedDomain(null);
  writeDomainLockFlag(null);
}
