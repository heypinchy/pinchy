import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname, join } from "path";

function getAuthProfilesPath(): string {
  const dataPath = process.env.OPENCLAW_DATA_PATH ?? "/openclaw-config";
  return join(dataPath, "auth-profiles.json");
}

export interface OpenAiCodexProfile {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export function writeAuthProfiles(params: { openaiCodex: OpenAiCodexProfile | null }): void {
  const path = getAuthProfilesPath();
  const hasAnyProfile = params.openaiCodex !== null;

  if (!hasAnyProfile) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }

  const { access, refresh, expires, accountId } = params.openaiCodex;
  const payload = {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh,
        expires,
        accountId,
      },
    },
  };

  const content = JSON.stringify(payload, null, 2);
  try {
    if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  } catch {
    // continue to write
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}
