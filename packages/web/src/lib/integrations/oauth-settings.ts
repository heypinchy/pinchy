import { getSetting, setSetting } from "@/lib/settings";

export const GOOGLE_OAUTH_SETTINGS_KEY = "google_oauth_credentials";

const SETTINGS_KEYS = {
  google: GOOGLE_OAUTH_SETTINGS_KEY,
} as const;

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
}

function isValidOAuthSettings(value: unknown): value is OAuthSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OAuthSettings).clientId === "string" &&
    typeof (value as OAuthSettings).clientSecret === "string"
  );
}

export async function getOAuthSettings(provider: "google"): Promise<OAuthSettings | null> {
  const raw = await getSetting(SETTINGS_KEYS[provider]);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidOAuthSettings(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveOAuthSettings(
  provider: "google",
  settings: OAuthSettings
): Promise<void> {
  await setSetting(SETTINGS_KEYS[provider], JSON.stringify(settings), true);
}
