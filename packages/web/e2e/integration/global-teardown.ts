// packages/web/e2e/integration/global-teardown.ts
import path from "path";
import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";

const ADMIN_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy";
const INTEGRATION_DB = "pinchy_integration_test";
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const FAKE_OLLAMA_PID_PATH = "/tmp/pinchy-fake-ollama.pid";

function stopFakeOllamaProcess() {
  if (!existsSync(FAKE_OLLAMA_PID_PATH)) return;
  const pid = Number(readFileSync(FAKE_OLLAMA_PID_PATH, "utf8"));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process is already gone.
    }
  }
  try {
    unlinkSync(FAKE_OLLAMA_PID_PATH);
  } catch {
    // Best-effort cleanup.
  }
}

export default async function globalTeardown() {
  // 1. Stop fake Ollama
  stopFakeOllamaProcess();
  console.log("[integration-teardown] fake Ollama stopped");

  // 2. Drop test DB
  const postgres = (await import("postgres")).default;
  const sql = postgres(ADMIN_DB_URL);
  await sql.unsafe(`DROP DATABASE IF EXISTS ${INTEGRATION_DB} WITH (FORCE)`);
  await sql.end();
  console.log("[integration-teardown] test DB dropped");

  // 3. Capture OpenClaw container logs BEFORE teardown so the workflow's
  //    failure handler has something to show. Without this, by the time
  //    the workflow runs `docker compose logs` the container is gone.
  try {
    execSync(
      "docker compose -f docker-compose.integration.yml logs openclaw > /tmp/openclaw-integration.log 2>&1 || true",
      { cwd: PROJECT_ROOT }
    );
    console.log("[integration-teardown] OpenClaw logs captured to /tmp/openclaw-integration.log");
  } catch {
    // Best-effort; don't fail teardown on log capture
  }

  // 4. Stop Docker integration stack
  execSync("docker compose -f docker-compose.integration.yml down", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  console.log("[integration-teardown] Docker integration stack stopped");
}
