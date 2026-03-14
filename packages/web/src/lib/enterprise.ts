import { getSetting } from "@/lib/settings";
import { validateLicense, type LicenseStatus } from "@/lib/license";

export type { LicenseStatus, LicenseType } from "@/lib/license";

// Production public key (ES256 / P-256)
// Generated with: npx tsx scripts/generate-license.ts --generate-keypair
const PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_ACTUAL_PUBLIC_KEY
-----END PUBLIC KEY-----`;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedStatus: LicenseStatus | null = null;
let cacheTimestamp = 0;

/**
 * Load the license token from env var (priority) or DB setting.
 */
async function loadToken(): Promise<string> {
  if (process.env.PINCHY_ENTERPRISE_KEY) {
    return process.env.PINCHY_ENTERPRISE_KEY;
  }
  return (await getSetting("enterprise_key")) ?? "";
}

/**
 * Get the full license status. Cached for 1 hour.
 * Pass publicKeyPem only in tests — production uses the hardcoded key.
 */
export async function getLicenseStatus(
  publicKeyPem: string = PRODUCTION_PUBLIC_KEY
): Promise<LicenseStatus> {
  const now = Date.now();
  if (cachedStatus && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const token = await loadToken();
  cachedStatus = await validateLicense(token, publicKeyPem);
  cacheTimestamp = now;
  return cachedStatus;
}

/**
 * Clear the cached license status. Call after key changes (e.g. via Settings UI).
 */
export function clearLicenseCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
}

/**
 * Check if enterprise features are enabled. Boolean shorthand.
 * All existing call sites use this — no changes needed.
 */
export async function isEnterprise(publicKeyPem: string = PRODUCTION_PUBLIC_KEY): Promise<boolean> {
  const status = await getLicenseStatus(publicKeyPem);
  return status.active;
}
