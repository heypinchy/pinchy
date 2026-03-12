import { getSetting } from "@/lib/settings";

/**
 * Check if enterprise features are enabled.
 *
 * For now, checks the PINCHY_ENTERPRISE_KEY env var or a DB setting.
 * Will be replaced with proper license validation in the future.
 */
export async function isEnterprise(): Promise<boolean> {
  // Check env var first (for Docker deployments)
  if (process.env.PINCHY_ENTERPRISE_KEY) return true;

  // Check DB setting (for UI-configured key)
  const key = await getSetting("enterprise_key");
  return !!key;
}
