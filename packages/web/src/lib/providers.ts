export type ProviderName = "anthropic" | "openai" | "google";

interface ProviderConfig {
  name: string;
  settingsKey: string;
  envVar: string;
  defaultModel: string;
  placeholder: string;
}

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    name: "Anthropic",
    settingsKey: "anthropic_api_key",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    placeholder: "sk-ant-...",
  },
  openai: {
    name: "OpenAI",
    settingsKey: "openai_api_key",
    envVar: "OPENAI_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
    placeholder: "sk-...",
  },
  google: {
    name: "Google",
    settingsKey: "google_api_key",
    envVar: "GEMINI_API_KEY",
    defaultModel: "google/gemini-2.5-flash",
    placeholder: "AIza...",
  },
};

export async function validateProviderKey(
  provider: ProviderName,
  apiKey: string
): Promise<boolean> {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  try {
    let response: Response;

    switch (provider) {
      case "anthropic":
        response = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        });
        break;
      case "openai":
        response = await fetch("https://api.openai.com/v1/models", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        break;
      case "google":
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
          {}
        );
        break;
    }

    return response.ok;
  } catch {
    return false;
  }
}
