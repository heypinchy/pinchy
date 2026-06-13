import { getSetting, setSetting, deleteSetting } from "@/lib/settings";

export const GOOGLE_OAUTH_SETTINGS_KEY = "google_oauth_credentials";
export const MICROSOFT_OAUTH_SETTINGS_KEY = "microsoft_oauth_credentials";

const SETTINGS_KEYS = {
  google: GOOGLE_OAUTH_SETTINGS_KEY,
  microsoft: MICROSOFT_OAUTH_SETTINGS_KEY,
} as const;

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
}

export interface MicrosoftOAuthSettings extends OAuthSettings {
  tenantId?: string;
}

type ProviderSettings = {
  google: OAuthSettings;
  microsoft: MicrosoftOAuthSettings;
};

function isValidOAuthSettings(value: unknown): value is OAuthSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OAuthSettings).clientId === "string" &&
    typeof (value as OAuthSettings).clientSecret === "string"
  );
}

export async function getOAuthSettings<P extends keyof ProviderSettings>(
  provider: P
): Promise<ProviderSettings[P] | null> {
  const raw = await getSetting(SETTINGS_KEYS[provider]);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidOAuthSettings(parsed)) return null;
    return parsed as ProviderSettings[P];
  } catch {
    return null;
  }
}

export async function saveOAuthSettings<P extends keyof ProviderSettings>(
  provider: P,
  settings: ProviderSettings[P]
): Promise<void> {
  await setSetting(SETTINGS_KEYS[provider], JSON.stringify(settings), true);
}

export async function deleteOAuthSettings(provider: keyof ProviderSettings): Promise<void> {
  await deleteSetting(SETTINGS_KEYS[provider]);
}
