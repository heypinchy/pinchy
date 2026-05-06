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
import { execSync, spawn } from "child_process";
import path from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { networkInterfaces } from "os";
import { FAKE_OLLAMA_PORT } from "./fake-ollama-server";

const ADMIN_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy";
const INTEGRATION_DB = "pinchy_integration_test";
const INTEGRATION_DB_URL = `postgresql://pinchy:pinchy_dev@localhost:5435/${INTEGRATION_DB}`;
const CONFIG_DIR = "/tmp/pinchy-integration-openclaw";
const SECRETS_DIR = "/tmp/pinchy-integration-secrets";
const FAKE_OLLAMA_PID_PATH = "/tmp/pinchy-fake-ollama.pid";
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

function hostNetworkIps(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function stopStaleFakeOllamaProcess() {
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

function startFakeOllamaProcess() {
  stopStaleFakeOllamaProcess();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(PACKAGE_ROOT, "e2e/integration/fake-ollama-process.ts")],
    {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();
  if (child.pid) {
    writeFileSync(FAKE_OLLAMA_PID_PATH, String(child.pid));
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
  startFakeOllamaProcess();
  console.log(`[integration-setup] fake Ollama started on port ${FAKE_OLLAMA_PORT}`);

  const dockerStackRunning = isDockerStackRunning();

  // 2. Ensure bind-mount targets exist BEFORE docker compose runs.
  //    If Docker creates them, they are owned by root and Pinchy (host, non-root)
  //    can't write secrets.json there.
  if (!dockerStackRunning) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    rmSync(SECRETS_DIR, { recursive: true, force: true });
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(`${CONFIG_DIR}/workspaces`, { recursive: true });
  mkdirSync(SECRETS_DIR, { recursive: true });

  // 3. Start Docker integration stack (skip if already running, e.g. pre-started in CI)
  if (dockerStackRunning) {
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

  // 5. Seed Ollama URL, default provider, and a fake Ollama-Cloud key.
  //
  //    On Linux the container's default gateway is usually the host. On Docker
  //    Desktop, host.docker.internal is the reliable host route. Probe both from
  //    inside the OpenClaw container and use the first URL that reaches fake Ollama.
  //
  //    The Ollama-Cloud key is intentionally a dummy value — fake Ollama doesn't need
  //    auth. We seed it so Pinchy's regenerateOpenClawConfig() writes the
  //    `models.providers.ollama-cloud.apiKey: secretRef(...)` reference into
  //    openclaw.json (see openclaw-config.ts ~line 615). That makes OpenClaw resolve
  //    the SecretRef on every gateway boot/reload — which exercises the strict
  //    "secrets.json owner must equal process uid" check that v0.5.0's tmpfs
  //    architecture would otherwise leave untested. Without this seed, the integration
  //    stack passes even when secrets ownership is misconfigured, because no SecretRef
  //    reference ever forces OpenClaw to read secrets.json.
  let ollamaHostIp = "172.17.0.1"; // Docker default Linux bridge gateway fallback
  try {
    const gwOutput = execSync(
      `docker compose -f docker-compose.integration.yml exec openclaw sh -c "ip route show default 2>/dev/null | awk '/default/ { print \\$3; exit }'"`,
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "pipe" }
    ).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(gwOutput)) {
      ollamaHostIp = gwOutput;
    }
  } catch {
    // Use the 172.17.0.1 fallback
  }
  let dockerHostIp = "";
  try {
    dockerHostIp = execSync(
      `docker compose -f docker-compose.integration.yml exec -T openclaw sh -c "getent hosts host.docker.internal 2>/dev/null | awk '{ print \\$1; exit }'"`,
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "pipe" }
    ).trim();
  } catch {
    // Ignore; the gateway candidate and hostname fallback remain below.
  }
  const ollamaCandidates = [
    `http://${ollamaHostIp}:${FAKE_OLLAMA_PORT}`,
    ...(dockerHostIp ? [`http://${dockerHostIp}:${FAKE_OLLAMA_PORT}`] : []),
    ...hostNetworkIps().map((ip) => `http://${ip}:${FAKE_OLLAMA_PORT}`),
    `http://host.docker.internal:${FAKE_OLLAMA_PORT}`,
    `http://docker.for.mac.host.internal:${FAKE_OLLAMA_PORT}`,
  ];
  const uniqueOllamaCandidates = [...new Set(ollamaCandidates)];
  const canReachOllamaFromOpenClaw = (url: string) => {
    const probe = [
      "fetch(process.argv[1] + '/__pinchy_fake_ollama', { signal: AbortSignal.timeout(1500) })",
      ".then(async (res) => {",
      "  if (!res.ok) process.exit(1);",
      "  const data = await res.json().catch(() => null);",
      "  process.exit(data?.ok === true ? 0 : 1);",
      "})",
      ".catch(() => process.exit(1))",
    ].join("");
    try {
      execSync(
        `docker compose -f docker-compose.integration.yml exec -T openclaw node -e ${JSON.stringify(probe)} ${JSON.stringify(url)}`,
        { cwd: PROJECT_ROOT, stdio: "pipe" }
      );
      return true;
    } catch {
      return false;
    }
  };
  const ollamaLocalUrl = uniqueOllamaCandidates.find((candidate) =>
    canReachOllamaFromOpenClaw(candidate)
  );
  if (!ollamaLocalUrl) {
    throw new Error("[integration-setup] OpenClaw could not reach fake Ollama");
  }
  console.log(`[integration-setup] Ollama URL reachable from OpenClaw: ${ollamaLocalUrl}`);

  const postgres = (await import("postgres")).default;
  const sql = postgres(INTEGRATION_DB_URL);
  await sql.unsafe(`
    INSERT INTO settings (key, value, encrypted) VALUES
      ('ollama_local_url', '${ollamaLocalUrl}', false),
      ('default_provider', 'ollama-local', false),
      ('ollama_cloud_api_key', 'dummy-integration-test-key', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = false
  `);
  await sql.end();
  console.log("[integration-setup] Ollama URL + dummy cloud key seeded");

  // 6. Run setup wizard so Pinchy writes openclaw.json WITH Smithers before OpenClaw
  //    restarts. This must happen before restarting OpenClaw (step 7) so the container
  //    reads the populated config on startup.
  //    Note: webServer (Pinchy) is already running — Playwright starts it before globalSetup.
  console.log("[integration-setup] Running setup wizard...");
  const setupRes = await fetch("http://localhost:7779/api/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Issue #235: state-changing API requests need a same-origin source.
      // Without this, the CSRF gate returns 403 and the setup wizard runs
      // again later from the test itself — triggering a config rewrite +
      // OpenClaw restart cascade right when the test sends its message.
      Origin: "http://localhost:7779",
    },
    body: JSON.stringify({
      name: "Integration Admin",
      email: "admin@integration.local",
      password: "integration-password-123",
    }),
  });
  if (setupRes.status !== 201 && setupRes.status !== 403) {
    throw new Error(`[integration-setup] Setup failed with status ${setupRes.status}`);
  }
  console.log(`[integration-setup] Setup complete (status ${setupRes.status})`);

  // 7. Restart OpenClaw so it reads the fresh config (with Smithers). This bypasses
  //    the inotify bind-mount limitation where renameSync generates IN_MOVED_TO which
  //    OpenClaw's file watcher does not detect on CI bind-mounts.
  console.log("[integration-setup] Restarting OpenClaw container to reload config...");
  execSync("docker compose -f docker-compose.integration.yml restart openclaw", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });

  // 8. Wait for Pinchy to reconnect to OpenClaw (up to 300s).
  //    openclaw-node's exponential backoff (1s → 2s → 4s → … → 30s cap, plus
  //    the lib double-fires reconnect on every error+close pair) means a
  //    reconnect after a full container restart can take 45-90s before a
  //    timer happens to fire while the gateway is healthy. 300s covers the
  //    worst-case CI scenario where backoff and device-approval together
  //    push the total past 180s.
  console.log("[integration-setup] Waiting for Pinchy to reconnect to OpenClaw...");
  const deadline = Date.now() + 300000;
  let reconnected = false;
  let connectedSince: number | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost:7779/api/health/openclaw");
      const data = (await res.json()) as { connected: boolean };
      if (data.connected) {
        connectedSince ??= Date.now();
        if (Date.now() - connectedSince >= 5000) {
          reconnected = true;
          break;
        }
      } else {
        connectedSince = null;
      }
    } catch {
      // Pinchy may be briefly unavailable during OpenClaw restart
      connectedSince = null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!reconnected) {
    throw new Error("[integration-setup] Pinchy did not reconnect to OpenClaw within 300s");
  }
  console.log("[integration-setup] Pinchy reconnected to OpenClaw — integration stack ready");
}
