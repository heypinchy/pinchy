import * as fs from "fs";
import * as path from "path";

export type AuthProfilesProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama-local"
  | "ollama-cloud";

export type WriteAgentAuthProfilesParams = {
  /** Filesystem root that will be mounted as /root/.openclaw inside OpenClaw container */
  configRoot: string;
  agentId: string;
  /** Providers configured for this agent. Empty array → empty profiles object. */
  providers: AuthProfilesProvider[];
};

export async function writeAgentAuthProfiles(params: WriteAgentAuthProfilesParams): Promise<void> {
  const dir = path.join(params.configRoot, "agents", params.agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });

  const profiles: Record<string, unknown> = {};
  for (const provider of params.providers) {
    profiles[`${provider}-default`] = {
      type: "api_key" as const,
      provider,
      keyRef: { kind: "secret" as const, path: `providers.${provider}.apiKey` },
    };
  }

  const target = path.join(dir, "auth-profiles.json");
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ profiles }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}
