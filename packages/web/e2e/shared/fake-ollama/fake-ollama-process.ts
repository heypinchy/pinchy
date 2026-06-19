import { startFakeOllama, stopFakeOllama } from "./fake-ollama-server";

async function shutdown() {
  await stopFakeOllama();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

// startFakeOllama() now rejects on a listen failure (e.g. EADDRINUSE) instead
// of hanging. Fail the subprocess loudly with a non-zero exit code rather than
// letting it surface as an unhandled rejection, so the E2E global-setup that
// spawns this process sees a clean, diagnosable startup failure.
startFakeOllama().catch((err) => {
  console.error("[fake-ollama] failed to start:", err);
  process.exit(1);
});
