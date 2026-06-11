// packages/web/e2e/integration/global-setup.ts
//
// Issue #196 Tier 3: the integration suite now runs against the production
// Pinchy image inside the Docker compose stack (docker-compose.yml +
// docker-compose.e2e.yml + docker-compose.integration.yml). Pinchy itself
// is no longer started by Playwright — its container is up before this
// hook runs.
//
// Local dev: bring the stack up first:
//   docker compose -f docker-compose.yml -f docker-compose.e2e.yml \
//                  -f docker-compose.integration.yml up --build -d
//   PINCHY_VERSION=local pnpm -C packages/web test:integration
//
// For CI: the integration job starts the stack before invoking Playwright.
import { execSync, spawn } from "child_process";
import path from "path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { FAKE_OLLAMA_PORT } from "../shared/fake-ollama/fake-ollama-server";
import { stackDbUrl } from "../shared/stack-db";

const INTEGRATION_DB_URL = stackDbUrl(5435);
const FAKE_OLLAMA_PID_PATH = "/tmp/pinchy-fake-ollama.pid";
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const COMPOSE_FILES =
  "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.integration.yml";
const COMPOSE_ENV = { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" };
const PINCHY_URL = "http://localhost:7779";

function composeExec(service: string, cmd: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} exec -T ${service} ${cmd}`, {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
    env: COMPOSE_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function isPinchyReachable(): boolean {
  try {
    execSync(`curl -sf ${PINCHY_URL}/api/internal/openclaw-config-ready`, {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
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
    ["--import", "tsx", path.join(PACKAGE_ROOT, "e2e/shared/fake-ollama/fake-ollama-process.ts")],
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

export default async function globalSetup() {
  // 1. Verify the integration stack is up. Refuse to silently start it for
  //    the developer — the production-image build takes minutes, and
  //    starting it implicitly hides that cost.
  if (!isPinchyReachable()) {
    throw new Error(
      `[integration-setup] Pinchy is not reachable at ${PINCHY_URL}. ` +
        `Start the stack first:\n\n` +
        `  docker compose ${COMPOSE_FILES} up --build -d\n\n` +
        `Then re-run \`pnpm -C packages/web test:integration\`.`
    );
  }
  console.log(`[integration-setup] Pinchy reachable at ${PINCHY_URL}`);

  // 2. Start fake Ollama on the host (OpenClaw connects to it via the host
  //    gateway). Must be up before we seed the Ollama URL into Pinchy.
  startFakeOllamaProcess();
  console.log(`[integration-setup] fake Ollama started on port ${FAKE_OLLAMA_PORT}`);

  // 3. Probe which URL OpenClaw can use to reach the host fake Ollama. The
  //    candidates mirror the pre-#196 logic: Docker bridge gateway,
  //    host.docker.internal, and the *.local hostname Pinchy rewrites to
  //    when emitting config (OpenClaw 2026.4.27's isLocalBaseUrl allowlist).
  let ollamaHostIp = "172.17.0.1"; // Docker default Linux bridge gateway fallback
  try {
    const gwOutput = composeExec(
      "openclaw",
      `sh -c "ip route show default 2>/dev/null | awk '/default/ { print \\$3; exit }'"`
    );
    if (/^\d+\.\d+\.\d+\.\d+$/.test(gwOutput)) {
      ollamaHostIp = gwOutput;
    }
  } catch {
    // Use the 172.17.0.1 fallback
  }
  let dockerHostIp = "";
  try {
    dockerHostIp = composeExec(
      "openclaw",
      `sh -c "getent hosts host.docker.internal 2>/dev/null | awk '{ print \\$1; exit }'"`
    );
  } catch {
    // Ignore; the gateway candidate and hostname fallback remain below.
  }
  const ollamaCandidates = [
    `http://${ollamaHostIp}:${FAKE_OLLAMA_PORT}`,
    ...(dockerHostIp ? [`http://${dockerHostIp}:${FAKE_OLLAMA_PORT}`] : []),
    `http://host.docker.internal:${FAKE_OLLAMA_PORT}`,
    `http://ollama.local:${FAKE_OLLAMA_PORT}`,
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
        `docker compose ${COMPOSE_FILES} exec -T openclaw node -e ${JSON.stringify(probe)} ${JSON.stringify(url)}`,
        { cwd: PROJECT_ROOT, env: COMPOSE_ENV, stdio: "pipe" }
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

  // 4. Seed Ollama URL, default provider, and a fake Ollama-Cloud key.
  //    The Ollama-Cloud key is intentionally a dummy value — fake Ollama
  //    doesn't need auth. We seed it so regenerateOpenClawConfig() writes
  //    a SecretRef for `models.providers.ollama-cloud.apiKey` into
  //    openclaw.json, which forces OpenClaw to resolve secrets.json on
  //    every reload — exercises the strict ownership check from #200.
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

  // 5. Run the setup wizard. The container's entrypoint runs migrations
  //    against an empty DB at boot, so on a fresh CI run there is no admin
  //    yet — the wizard creates one (and Smithers) before tests log in.
  console.log("[integration-setup] Running setup wizard...");
  const setupRes = await fetch(`${PINCHY_URL}/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Issue #235: state-changing API requests need a same-origin source.
      // Without this, the CSRF gate returns 403 and the setup wizard runs
      // again later from the test itself — triggering a config rewrite +
      // OpenClaw restart cascade right when the test sends its message.
      Origin: PINCHY_URL,
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

  // 6. Restart OpenClaw so it reads the fresh config (with Smithers + the
  //    ollama provider seeded above). The compose stack started before
  //    Pinchy had Smithers in its DB, so the cold-start config is sparse;
  //    a restart picks up the targeted-write config Pinchy emitted during
  //    setup.
  console.log("[integration-setup] Restarting OpenClaw container to reload config...");
  execSync(`docker compose ${COMPOSE_FILES} restart openclaw`, {
    cwd: PROJECT_ROOT,
    env: COMPOSE_ENV,
    stdio: "inherit",
  });

  // 7. Wait for Pinchy to reconnect to OpenClaw (up to 300s).
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
      const res = await fetch(`${PINCHY_URL}/api/health/openclaw`);
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
