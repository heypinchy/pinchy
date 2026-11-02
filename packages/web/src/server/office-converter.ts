/**
 * Entrypoint of the `office-converter` sidecar (docker-compose.yml).
 *
 * The only process in a Pinchy deployment that opens an Office file with
 * LibreOffice. It runs in a container with `network_mode: none`, no secrets
 * and no volume but the spool, and listens on a Unix socket in that spool —
 * see lib/knowledge/office-converter-sidecar.ts for the protocol and why.
 *
 * Deliberately tiny and dependency-free: it imports the protocol and the
 * soffice spawn, both Node built-ins only, and nothing of the web app — no
 * database, no settings, no secrets to load.
 */
import {
  createOfficeConverterServer,
  listenOfficeConverter,
  converterSocketPath,
} from "../lib/knowledge/office-converter-sidecar";
import { runSoffice } from "../lib/knowledge/office-soffice";
import { rm } from "node:fs/promises";

async function main(): Promise<void> {
  const spoolDir = process.env.KB_OFFICE_SPOOL_DIR;
  if (!spoolDir) {
    console.error(
      "[office-converter] KB_OFFICE_SPOOL_DIR is not set — the converter has no spool to listen in"
    );
    process.exit(2);
  }

  const server = createOfficeConverterServer({
    spoolDir,
    runConverter: async (run) => {
      const started = Date.now();
      const result = await runSoffice(run);
      // Counts and timings only: no file name, no content.
      console.log(
        `[office-converter] batch of ${run.inputs.length}: exit ${result.code ?? result.signal}${result.timedOut ? " (timed out)" : ""} in ${Date.now() - started} ms`
      );
      return result;
    },
  });

  await listenOfficeConverter(server, spoolDir);
  console.log(`[office-converter] listening on ${converterSocketPath(spoolDir)}`);

  const shutdown = () => {
    server.close();
    rm(converterSocketPath(spoolDir), { force: true }).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error("[office-converter] failed to start:", err);
  process.exit(1);
});
