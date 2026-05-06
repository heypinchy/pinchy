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
};

export function writeSecretsFile(bundle: SecretsBundle): void {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  const newContent = JSON.stringify(bundle, null, 2);

  // Skip the write when content is unchanged to avoid a spurious inotify event
  // that would trigger OpenClaw's secrets-file watcher unnecessarily.
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
