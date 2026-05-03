export type ProviderName = "anthropic" | "openai" | "google" | "ollama-cloud" | "ollama-local";

interface ProviderConfig {
  name: string;
  authType: "api-key" | "url";
  settingsKey: string;
  envVar: string;
  defaultModel: string;
  placeholder: string;
}

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    name: "Anthropic",
    authType: "api-key",
    settingsKey: "anthropic_api_key",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    placeholder: "sk-ant-...",
  },
  openai: {
    name: "OpenAI",
    authType: "api-key",
    settingsKey: "openai_api_key",
    envVar: "OPENAI_API_KEY",
    defaultModel: "openai/gpt-5.4-mini",
    placeholder: "sk-...",
  },
  google: {
    name: "Google",
    authType: "api-key",
    settingsKey: "google_api_key",
    envVar: "GEMINI_API_KEY",
    defaultModel: "google/gemini-2.5-flash",
    placeholder: "AIza...",
  },
  "ollama-cloud": {
    name: "Ollama Cloud",
    authType: "api-key",
    settingsKey: "ollama_cloud_api_key",
    envVar: "OLLAMA_CLOUD_API_KEY",
    defaultModel: "ollama-cloud/gemini-3-flash-preview",
    placeholder: "sk-...",
  },
  "ollama-local": {
    name: "Ollama (Local)",
    authType: "url",
    settingsKey: "ollama_local_url",
    envVar: "",
    defaultModel: "ollama/llama3.2",
    placeholder: "http://host.docker.internal:11434",
  },
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: "invalid_key" }
  | { valid: false; error: "network_error" }
  | { valid: false; error: "provider_error"; status: number }
  | { valid: false; error: "no_compatible_models" };

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
    case "ollama-cloud":
      // /v1/models is a public catalog and returns 200 for any token, so it
      // can't distinguish a real key from a typo. /v1/chat/completions checks
      // auth before body validation: with an empty body a valid key gets 400,
      // an invalid key gets 401. No tokens consumed either way.
      return fetch("https://ollama.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    case "ollama-local":
      throw new Error("Use validateProviderUrl for URL-based providers");
  }
}

export async function validateProviderUrl(url: string): Promise<ValidationResult> {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/api/tags`);
    if (response.ok) return { valid: true };
    return { valid: false, error: "provider_error", status: response.status };
  } catch {
    return { valid: false, error: "network_error" };
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

    // Ollama Cloud's validation probe sends an empty body to chat/completions.
    // A 400 response means auth passed and the body was (as intended) rejected —
    // so the key is valid.
    if (provider === "ollama-cloud" && response.status === 400) {
      return { valid: true };
    }

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
