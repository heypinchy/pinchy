// packages/web/e2e/integration/global-teardown.ts
import path from "path";
import { execSync } from "child_process";
import { stopFakeOllama } from "./fake-ollama-server";

const ADMIN_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy";
const INTEGRATION_DB = "pinchy_integration_test";
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");

export default async function globalTeardown() {
  // 1. Stop fake Ollama
  await stopFakeOllama();
  console.log("[integration-teardown] fake Ollama stopped");

  // 2. Drop test DB
  const postgres = (await import("postgres")).default;
  const sql = postgres(ADMIN_DB_URL);
  await sql.unsafe(`DROP DATABASE IF EXISTS ${INTEGRATION_DB} WITH (FORCE)`);
  await sql.end();
  console.log("[integration-teardown] test DB dropped");

  // 3. Stop Docker integration stack
  execSync("docker compose -f docker-compose.integration.yml down", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  console.log("[integration-teardown] Docker integration stack stopped");
}
