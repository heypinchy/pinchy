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
  /**
   * Providers configured for this agent. Empty array → remove auth-profiles.json
   * (if present) so OpenClaw does not enter strict auth mode for this agent.
   * OpenClaw's hasAnyAuthProfileStoreSource() returns TRUE whenever the file
   * exists — even an empty profiles object enables strict mode.
   */
  providers: AuthProfilesProvider[];
};

export async function writeAgentAuthProfiles(params: WriteAgentAuthProfilesParams): Promise<void> {
  const dir = path.join(params.configRoot, "agents", params.agentId, "agent");
  const target = path.join(dir, "auth-profiles.json");

  if (params.providers.length === 0) {
    // No profiles → remove the file so OpenClaw doesn't enter strict auth mode.
    try {
      fs.unlinkSync(target);
    } catch {
      // File doesn't exist — that's fine.
    }
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const profiles: Record<string, unknown> = {};
  for (const provider of params.providers) {
    profiles[`${provider}-default`] = {
      type: "api_key" as const,
      provider,
      keyRef: { kind: "secret" as const, path: `providers.${provider}.apiKey` },
    };
  }

  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ profiles }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}
