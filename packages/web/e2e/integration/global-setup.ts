// packages/web/e2e/integration/global-setup.ts
import { execSync } from "child_process";
import path from "path";
import { mkdirSync } from "fs";
import { startFakeOllama, FAKE_OLLAMA_PORT } from "./fake-ollama-server";

const ADMIN_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy";
const INTEGRATION_DB = "pinchy_integration_test";
const INTEGRATION_DB_URL = `postgresql://pinchy:pinchy_dev@localhost:5435/${INTEGRATION_DB}`;
const CONFIG_DIR = "/tmp/pinchy-integration-openclaw";
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

export default async function globalSetup() {
  // 1. Start fake Ollama (must be up before OpenClaw connects to the provider)
  await startFakeOllama();
  console.log(`[integration-setup] fake Ollama started on port ${FAKE_OLLAMA_PORT}`);

  // 2. Ensure config dir exists (OpenClaw will be mounted here)
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(`${CONFIG_DIR}/workspaces`, { recursive: true });

  // 3. Start Docker integration stack
  execSync("docker compose -f docker-compose.integration.yml up -d --wait", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  console.log("[integration-setup] Docker integration stack started");

  // 4. Create test DB and run migrations
  const postgres = (await import("postgres")).default;
  const adminSql = postgres(ADMIN_DB_URL);
  await adminSql.unsafe(`DROP DATABASE IF EXISTS ${INTEGRATION_DB} WITH (FORCE)`);
  await adminSql.unsafe(`CREATE DATABASE ${INTEGRATION_DB}`);
  await adminSql.end();

  execSync("pnpm db:migrate", {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: INTEGRATION_DB_URL },
    stdio: "inherit",
  });
  console.log("[integration-setup] DB migrated");

  // 5. Seed Ollama URL and default provider BEFORE Pinchy starts
  //    host.docker.internal reaches the fake Ollama from inside the OpenClaw container
  const sql = postgres(INTEGRATION_DB_URL);
  await sql.unsafe(`
    INSERT INTO settings (key, value, encrypted) VALUES
      ('ollama_local_url', 'http://host.docker.internal:11435', false),
      ('default_provider', 'ollama-local', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = false
  `);
  await sql.end();
  console.log("[integration-setup] Ollama URL seeded");
}
