import {
  TRANSIENT_PATTERN,
  PROVIDER_CONFIG_PATTERN,
  PROVIDER_REJECTED_GENERIC_PATTERN,
} from "@/server/error-patterns";

export const PROVIDER_SETTINGS_HINT = "Go to Settings > Providers to check your API configuration.";

export function getErrorHint(errorText: string, userRole: string): string | null {
  // Check transient errors first — "Rate limit exceeded" contains "exceeded"
  // which would otherwise match the provider config pattern.
  if (TRANSIENT_PATTERN.test(errorText)) {
    return "Try again in a moment.";
  }

  if (PROVIDER_CONFIG_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  // OpenClaw's generic provider-rejection catch-all (#584). The real cause —
  // most often a provider-account issue like depleted credit or an invalid
  // key — never reaches Pinchy in the chunk text, so the audit class stays
  // honest (`unknown`). The bare wording reads like a malformed-request bug;
  // pointing an admin at their provider configuration is the most actionable
  // honest guidance we can give without asserting a cause we can't prove.
  if (PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  return null;
}
