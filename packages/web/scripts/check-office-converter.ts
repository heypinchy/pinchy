/**
 * Converts one small Word document through the knowledge base's real
 * conversion path — the one ingest uses — and reports what came back.
 *
 * Run inside a running `pinchy` container, as the pinchy user (the converter
 * runs as the same uid and must be able to write into the batch):
 *
 *   docker compose exec -T --user pinchy pinchy \
 *     node --import tsx scripts/check-office-converter.ts --expect converted
 *
 * CI's docker-smoke job runs it twice against the production stack: once with
 * the office-converter service up (`--expect converted`), and once with it
 * stopped (`--expect infrastructure`). The second run is the point: it proves
 * the web container does not convert by itself when the sidecar is gone — the
 * fallback that would silently put LibreOffice back next to the secrets.
 *
 * Also useful by hand when Office documents report "office converter is not
 * reachable": it shows the same reason the index run would.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OfficeArtifactStore } from "../src/lib/knowledge/office-artifacts";
import { convertOfficeFiles, type ConversionStatus } from "../src/lib/knowledge/office-convert";
import { docxWith, relationships } from "../src/test-helpers/office-zip";

const STATUSES: readonly ConversionStatus[] = ["converted", "failed", "infrastructure"];

async function main(): Promise<number> {
  const flag = process.argv.indexOf("--expect");
  const expected = flag === -1 ? "converted" : process.argv[flag + 1];
  if (!STATUSES.includes(expected as ConversionStatus)) {
    console.error(`--expect must be one of ${STATUSES.join(", ")}, got ${expected}`);
    return 2;
  }

  const root = mkdtempSync(join(tmpdir(), "pinchy-office-check-"));
  try {
    const source = join(root, "check.docx");
    writeFileSync(
      source,
      docxWith({
        text: "Pinchy converter check for Domžale and GODIČ TORKAR",
        documentRels: relationships(),
      })
    );

    const [outcome] = await convertOfficeFiles([{ absPath: source }], {
      store: new OfficeArtifactStore(join(root, "artifacts")),
    });
    console.log(
      JSON.stringify({
        spool: process.env.KB_OFFICE_SPOOL_DIR ?? null,
        status: outcome.status,
        reason: outcome.reason,
        verification: outcome.verification?.status,
      })
    );
    if (outcome.status !== expected) {
      console.error(`expected ${expected}, got ${outcome.status}`);
      return 1;
    }
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  }
);
