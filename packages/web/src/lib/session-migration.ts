import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

export function migrateSessionKeys(openclawDataPath: string): void {
  const agentsDir = join(openclawDataPath, "agents");
  if (!existsSync(agentsDir)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(agentsDir) as unknown as string[];
  } catch {
    return;
  }

  for (const agentId of agentDirs) {
    const sessionsFile = join(agentsDir, agentId, "sessions", "sessions.json");
    if (!existsSync(sessionsFile)) continue;

    let raw: string;
    try {
      raw = readFileSync(sessionsFile, "utf-8");
    } catch {
      continue;
    }

    const sessions = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    const migrated: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(sessions)) {
      const match = key.match(/^(agent:[^:]+):user-(.+)$/);
      if (match) {
        const newKey = `${match[1]}:direct:${match[2]}`;
        migrated[newKey] = value;
        changed = true;
      } else {
        migrated[key] = value;
      }
    }

    if (changed) {
      writeFileSync(sessionsFile, JSON.stringify(migrated, null, 2), "utf-8");
      console.log(`Migrated session keys for agent ${agentId}`);
    }
  }
}
