import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { PROVIDERS, type ProviderName } from "@/lib/providers";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

interface OpenClawConfigParams {
  provider: ProviderName;
  apiKey: string;
  model: string;
}

function readExistingConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function writeOpenClawConfig({ provider, apiKey, model }: OpenClawConfigParams) {
  const existing = readExistingConfig();

  const pinchyFields = {
    gateway: { mode: "local", bind: "lan" },
    env: {
      [PROVIDERS[provider].envVar]: apiKey,
    },
    agents: {
      defaults: {
        model: { primary: model },
      },
    },
  };

  const merged = deepMerge(existing, pinchyFields);

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}
