import { getSetting } from "@/lib/settings";
import { validateLicense, type LicenseStatus } from "@/lib/license";
import { deriveLicenseState, type LicenseState } from "@/lib/license-state";
import { DEVELOPMENT_PUBLIC_KEY, PRODUCTION_PUBLIC_KEY } from "@/lib/license-keys";

export type { LicenseStatus, LicenseType } from "@/lib/license";
export type { LicenseState } from "@/lib/license-state";

export interface LicenseInfo {
  enterprise: boolean;
  state: LicenseState;
  type: string | null;
  org: string | null;
  expiresAt: string | null;
  paidUntil: string | null;
  daysRemaining: number | null;
  managedByEnv: boolean;
  maxUsers: number;
  seatsUsed: number;
  hasGatedConfig: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedStatus: LicenseStatus | null = null;
let cacheTimestamp = 0;

/**
 * Load the license token. Env var always wins (immutable config).
 * DB setting is only used when no env var is set.
 */
async function loadToken(): Promise<string> {
  if (process.env.PINCHY_ENTERPRISE_KEY) {
    return process.env.PINCHY_ENTERPRISE_KEY;
  }
  return (await getSetting("enterprise_key")) ?? "";
}

/**
 * Whether the license key is configured via environment variable.
 * When true, the key cannot be changed via the Settings UI.
 */
export function isKeyFromEnv(): boolean {
  return !!process.env.PINCHY_ENTERPRISE_KEY;
}

/**
 * Whether a license signed by the DEVELOPMENT key is honoured.
 *
 * False in production, which is the whole point: the development license is
 * committed to this repository, so anything that honours it is unlocked for
 * everyone who can read the repository (#1083). A dev stack (`next dev`, the
 * E2E web server) runs outside production and honours it.
 *
 * Read per call rather than captured at module load — NODE_ENV is stubbed per
 * test, and a module-level constant would freeze whatever the first import saw.
 */
function developmentLicensesHonoured(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Validate against the key ring rather than a single key: the production key
 * always, the development key only where development licenses are honoured.
 *
 * Order matters. The production key is asked first and its verdict wins when
 * it recognises the token at all (`active` or the authentic-but-`expired`
 * case), so a real customer license can never be re-read under the dev key.
 */
async function validateAgainstKeyRing(
  token: string,
  productionKeyPem: string
): Promise<LicenseStatus> {
  const status = await validateLicense(token, productionKeyPem);
  if (status.active || status.expired) return status;
  if (!developmentLicensesHonoured()) return status;

  const dev = await validateLicense(token, DEVELOPMENT_PUBLIC_KEY, { honourDevSubject: true });
  return dev.active || dev.expired ? dev : status;
}

/**
 * Validate a candidate token without storing it or touching the cache.
 *
 * This is the entry point for "would this key work?", which is a different
 * question from "what is this install licensed for?" and must be answerable
 * without changing the answer to the second one. `PUT /api/enterprise/key`
 * used to conflate them: it wrote the submitted key, asked `getLicenseStatus`,
 * and deleted the setting when the verdict came back inactive — so a typo cost
 * an admin the working license that had been there.
 *
 * It is deliberately the same code path `getLicenseStatus` takes, not a second
 * copy of it. The route decides with this function what the app then reads
 * through that one; a change to how a token is verified must reach both or the
 * route would accept a key the app treats as community.
 *
 * That invariant is why the key ring lives HERE and not in `getLicenseStatus`
 * (#1083). Put it one level down and the two diverge in the other direction:
 * on a dev stack the route would reject the development license while the app
 * honours it — the same class of bug, arriving as "your key is invalid" for a
 * key that demonstrably works.
 */
export async function validateLicenseToken(
  token: string,
  publicKeyPem: string = PRODUCTION_PUBLIC_KEY
): Promise<LicenseStatus> {
  return validateAgainstKeyRing(token, publicKeyPem);
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
  cachedStatus = await validateLicenseToken(token, publicKeyPem);
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

/**
 * The license state per pricing concept § 6, derived offline from the
 * (cached) license status and the current clock.
 */
export async function getLicenseState(
  publicKeyPem: string = PRODUCTION_PUBLIC_KEY
): Promise<LicenseState> {
  const status = await getLicenseStatus(publicKeyPem);
  return deriveLicenseState(status, new Date());
}
