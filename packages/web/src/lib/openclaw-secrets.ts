import { writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "fs";
import { dirname } from "path";

export type SecretRef = {
  source: "file";
  provider: "pinchy";
  id: string;
};

export function secretRef(id: string): SecretRef {
  return { source: "file", provider: "pinchy", id };
}

const DEFAULT_SECRETS_PATH = "/openclaw-secrets/secrets.json";

export type SecretsBundle = {
  gateway?: { token?: string };
  providers?: Record<string, { apiKey: string }>;
  integrations?: Record<string, Record<string, string>>;
  telegram?: Record<string, { botToken: string }>;
};

export function writeSecretsFile(bundle: SecretsBundle): void {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600); // enforce regardless of umask
  renameSync(tmp, path);
}
