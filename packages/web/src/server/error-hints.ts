import { TRANSIENT_PATTERN, PROVIDER_CONFIG_PATTERN } from "@/server/error-patterns";

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

  return null;
}
