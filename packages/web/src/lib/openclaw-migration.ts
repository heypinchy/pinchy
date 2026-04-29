import { existsSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const MARKER_FILE_NAME = ".secret-ref-migrated-v1";

export function migrateToSecretRef(configPath: string): void {
  const dir = dirname(configPath);
  const marker = join(dir, MARKER_FILE_NAME);
  if (existsSync(marker)) return;

  const bak = `${configPath}.bak`;
  if (existsSync(bak)) {
    unlinkSync(bak);
    console.log("[migration] deleted legacy openclaw.json.bak");
  }

  writeFileSync(marker, `migrated at ${new Date().toISOString()}\n`);
  console.log("[migration] secret-ref migration complete");
}
