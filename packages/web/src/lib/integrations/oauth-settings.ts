import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import {
  GOOGLE_OAUTH_SETTINGS_KEY,
  MICROSOFT_OAUTH_SETTINGS_KEY,
} from "@/lib/integrations/oauth-providers";

// The keys' single source of truth is the client-safe oauth-providers module
// (so Client Components importing the descriptor don't pull in this server-only
// file's db dependency). Re-export them here so existing consumers that import
// from oauth-settings.ts keep working unchanged.
export { GOOGLE_OAUTH_SETTINGS_KEY, MICROSOFT_OAUTH_SETTINGS_KEY };

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
