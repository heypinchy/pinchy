export type ProviderName = "anthropic" | "openai" | "google" | "ollama";

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
  ollama: {
    name: "Ollama",
    settingsKey: "ollama_api_key",
    envVar: "OLLAMA_API_KEY",
    defaultModel: "ollama-cloud/gemini-3-flash-preview:cloud",
    placeholder: "sk-...",
  },
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: "invalid_key" }
  | { valid: false; error: "network_error" }
  | { valid: false; error: "provider_error"; status: number };

function makeValidationRequest(provider: ProviderName, apiKey: string): Promise<Response> {
  switch (provider) {
    case "anthropic":
      return fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
    case "openai":
      return fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    case "google":
      return fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`, {});
    case "ollama":
      return fetch("https://ollama.com/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
  }
}

export async function validateProviderKey(
  provider: ProviderName,
  apiKey: string
): Promise<ValidationResult> {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  try {
    const response = await makeValidationRequest(provider, apiKey);

    if (response.ok) return { valid: true };

    // 401/403 could be a genuinely invalid key, or a transient auth issue
    // (observed with Claude Max OAuth tokens). Retry once before declaring invalid.
    if (response.status === 401 || response.status === 403) {
      await new Promise((r) => setTimeout(r, 1000));
      const retry = await makeValidationRequest(provider, apiKey);
      if (retry.ok) return { valid: true };
      return { valid: false, error: "invalid_key" };
    }

    // Anything else (429, 5xx, etc.) = provider issue, not necessarily a bad key
    return { valid: false, error: "provider_error", status: response.status };
  } catch {
    return { valid: false, error: "network_error" };
  }
}
