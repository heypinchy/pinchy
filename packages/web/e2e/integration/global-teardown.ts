// packages/web/e2e/integration/global-teardown.ts
//
// Issue #196 Tier 3: the integration stack (Pinchy + OpenClaw + Postgres)
// is owned by the CI workflow / local dev session, not by Playwright.
// This teardown only cleans up what Playwright started: the fake Ollama
// process on the host.
import { existsSync, readFileSync, unlinkSync } from "fs";

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
  stopFakeOllamaProcess();
  console.log("[integration-teardown] fake Ollama stopped");
}
