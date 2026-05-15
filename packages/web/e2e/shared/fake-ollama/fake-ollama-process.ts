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

void startFakeOllama();
