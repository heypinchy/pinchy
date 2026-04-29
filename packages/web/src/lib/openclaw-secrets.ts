import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "fs";
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
  // env: real values that start-openclaw.sh exports as process env vars on
  // container start. openclaw.json's env block holds only ${VAR} templates
  // that resolve against this process env at runtime — see
  // regenerateOpenClawConfig() for the full handshake.
  env?: Record<string, string>;
};

export function writeSecretsFile(bundle: SecretsBundle): void {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  const newContent = JSON.stringify(bundle, null, 2);

  // Skip the write when content is unchanged. Otherwise the mtime watcher
  // in start-openclaw.sh would see a fresh mtime on every Pinchy startup and
  // uselessly restart the OpenClaw gateway.
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === newContent) return;
    } catch {
      // Fall through and write — if read failed for any reason, a write attempt
      // is the safer recovery path than silently leaving stale content.
    }
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  // Mode 0600: owner-only read/write. The tmpfs directory mode (0770) already
  // restricts access to uid 999 (the pinchy user), but file-level 0600 is
  // cheap defense-in-depth against same-uid local processes (e.g. shells
  // inside docker exec).
  writeFileSync(tmp, newContent, { mode: 0o600 });
  chmodSync(tmp, 0o600); // enforce regardless of umask
  renameSync(tmp, path);
}

export function readSecretsFile(): SecretsBundle {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}
