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
  converterSocketPath,
  createOfficeConverterServer,
  leftoverProcesses,
  listenOfficeConverter,
  sweepSpool,
} from "../lib/knowledge/office-converter-sidecar";
import { runSoffice } from "../lib/knowledge/office-soffice";

async function main(): Promise<void> {
  const spoolDir = process.env.KB_OFFICE_SPOOL_DIR;
  if (!spoolDir) {
    console.error(
      "[office-converter] KB_OFFICE_SPOOL_DIR is not set — the converter has no spool to listen in"
    );
    process.exit(2);
  }

  // It runs as its own uid, in the web process's group, and the web process
  // removes each batch afterwards — including what LibreOffice wrote into it.
  // Group-writable output is what lets it.
  process.umask(0o007);

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
    leftovers: () => leftoverProcesses(),
    onLeftovers: (pids) => {
      // Something of the converter's outlived its batch and could still write
      // into the next one. Exit: the restart policy brings up a clean
      // container, and the init and everything left go with this one.
      console.error(
        `[office-converter] ${pids.length} process(es) outlived the batch — exiting so the container restarts`
      );
      process.exit(1);
    },
  });

  // What a previous run of this container could not clean up any more.
  await sweepSpool(spoolDir);
  await listenOfficeConverter(server, spoolDir);
  console.log(`[office-converter] listening on ${converterSocketPath(spoolDir)}`);

  // Stop without closing the server: closing would unlink the socket, and a
  // missing socket tells the web process there is no converter service at
  // all. One that is there but refuses connections is what it waits out — a
  // `docker compose restart`, a changed memory limit, a host restart — and
  // the next start replaces it (listenOfficeConverter).
  const shutdown = () => process.exit(0);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error("[office-converter] failed to start:", err);
  process.exit(1);
});
