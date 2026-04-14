// packages/web/e2e/integration/global-setup.ts
//
// NOTE on execution order: Playwright starts webServer BEFORE globalSetup.
// This means Pinchy starts before the DB is ready if Docker is not pre-started.
//
// For CI: the CI job starts Docker + migrates the DB in a separate step before
// running playwright. globalSetup detects the running stack and skips those steps.
//
// For local dev: run `docker compose -f docker-compose.integration.yml up -d --wait`
// and create the test DB manually before running `pnpm test:integration`, or
// accept that Pinchy's initial startup queries will fail and recover automatically.
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

/** Returns true if the integration Docker stack (DB + OpenClaw) is already running. */
function isDockerStackRunning(): boolean {
  try {
    const out = execSync(
      "docker compose -f docker-compose.integration.yml ps --services --filter status=running",
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "pipe" }
    );
    return out.includes("db") && out.includes("openclaw");
  } catch {
    return false;
  }
}

/** Returns true if the integration DB already exists and has been migrated. */
async function isDbReady(): Promise<boolean> {
  try {
    const postgres = (await import("postgres")).default;
    const sql = postgres(INTEGRATION_DB_URL, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1 FROM settings LIMIT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  // 1. Start fake Ollama (must be up before OpenClaw connects to the provider)
  await startFakeOllama();
  console.log(`[integration-setup] fake Ollama started on port ${FAKE_OLLAMA_PORT}`);

  // 2. Ensure config dir exists (OpenClaw will be mounted here)
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(`${CONFIG_DIR}/workspaces`, { recursive: true });

  // 3. Start Docker integration stack (skip if already running, e.g. pre-started in CI)
  if (isDockerStackRunning()) {
    console.log("[integration-setup] Docker integration stack already running — skipping start");
  } else {
    execSync("docker compose -f docker-compose.integration.yml up -d --wait", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    console.log("[integration-setup] Docker integration stack started");
  }

  // 4. Create test DB and run migrations (skip if already done, e.g. pre-migrated in CI)
  if (await isDbReady()) {
    console.log("[integration-setup] DB already migrated — skipping migration");
  } else {
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
  }

  // 5. Seed Ollama URL and default provider
  //    host.docker.internal reaches the fake Ollama from inside the OpenClaw container
  const postgres = (await import("postgres")).default;
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
