/**
 * Real-DB integration tests for the record of files the indexer cannot read
 * (#1267): what a run writes, what it must leave alone, and what an agent may
 * read back.
 *
 * Against a real Postgres for the same reason as unsearchable.integration.test:
 * every way this can be wrong is a way the SQL can be wrong — a replace scoped
 * by string prefix instead of by folder deletes a sibling's rows, and a read
 * that forgets the grant leaks the names of files the agent was never given.
 */
import { expect, it } from "vitest";

import {
  countUnsupportedFiles,
  listUnsupportedFiles,
  recordUnsupportedFiles,
  type UnsupportedFile,
} from "@/lib/knowledge/unsupported-files";

const ORG_ID = "org-kb-unsupported-test";

const files = (...paths: string[]) =>
  new Map(paths.map((p) => [p, p.slice(p.lastIndexOf(".")).toLowerCase()]));

async function readAll(
  orgId: string,
  allowedPaths: readonly string[],
  pageSize?: number
): Promise<UnsupportedFile[]> {
  const out: UnsupportedFile[] = [];
  for await (const page of listUnsupportedFiles(orgId, allowedPaths, { pageSize })) {
    out.push(...page);
  }
  return out;
}

it("records each file with its path and type, and reads them back in path order", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [{ rootDir: "/data", files: files("/data/scans/Plate.tif", "/data/Budget.xls") }],
    []
  );

  expect(await readAll(ORG_ID, ["/data"])).toEqual([
    { sourcePath: "/data/Budget.xls", type: ".xls" },
    { sourcePath: "/data/scans/Plate.tif", type: ".tif" },
  ]);
  expect(await countUnsupportedFiles(ORG_ID, ["/data"])).toBe(2);
});

// The list describes the share as the LAST run found it. A file somebody
// converted (or deleted) since must drop off, or the admin works through a
// list of problems that no longer exist.
it("replaces what an earlier run recorded under the same folder", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [{ rootDir: "/data", files: files("/data/Old.xls", "/data/Plate.tif") }],
    []
  );
  await recordUnsupportedFiles(ORG_ID, [{ rootDir: "/data", files: files("/data/Plate.tif") }], []);

  expect((await readAll(ORG_ID, ["/data"])).map((f) => f.sourcePath)).toEqual(["/data/Plate.tif"]);
});

// Folder boundary, not string prefix: a run over /data/hr knows nothing about
// /data/hr-archive and must not wipe what another run recorded there.
it("leaves rows outside the run's folders alone, including a sibling that shares a prefix", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [
      { rootDir: "/data/hr-archive", files: files("/data/hr-archive/Old.xls") },
      { rootDir: "/data/legal", files: files("/data/legal/Scan.tif") },
    ],
    []
  );
  await recordUnsupportedFiles(ORG_ID, [{ rootDir: "/data/hr", files: new Map() }], []);

  expect(
    (await readAll(ORG_ID, ["/data/hr-archive", "/data/legal"])).map((f) => f.sourcePath)
  ).toEqual(["/data/hr-archive/Old.xls", "/data/legal/Scan.tif"]);
});

// A folder the run could not look at (an unmounted share) is not evidence that
// its files are gone. Same rule the removal pass follows for documents.
it("keeps what was recorded under a folder the run had to leave as it was", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [{ rootDir: "/data", files: files("/data/share/Plate.tif", "/data/Budget.xls") }],
    []
  );
  await recordUnsupportedFiles(ORG_ID, [{ rootDir: "/data", files: new Map() }], ["/data/share"]);

  expect((await readAll(ORG_ID, ["/data"])).map((f) => f.sourcePath)).toEqual([
    "/data/share/Plate.tif",
  ]);
});

// Two granted roots that overlap (/data and /data/hr) find the same file twice.
it("records a file found by two overlapping roots once", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [
      { rootDir: "/data", files: files("/data/hr/Plate.tif") },
      { rootDir: "/data/hr", files: files("/data/hr/Plate.tif") },
    ],
    []
  );

  expect(await countUnsupportedFiles(ORG_ID, ["/data"])).toBe(1);
});

it("reads only what the agent's grants cover, as folder boundaries", async () => {
  await recordUnsupportedFiles(
    ORG_ID,
    [
      {
        rootDir: "/data",
        files: files("/data/hr/Plate.tif", "/data/hr_eu/A.xls", "/data/hrxeu/B.xls"),
      },
    ],
    []
  );

  expect((await readAll(ORG_ID, ["/data/hr_eu"])).map((f) => f.sourcePath)).toEqual([
    "/data/hr_eu/A.xls",
  ]);
  expect(await countUnsupportedFiles(ORG_ID, ["/data/hr"])).toBe(1);
});

it("reads nothing for an agent granted nothing", async () => {
  await recordUnsupportedFiles(ORG_ID, [{ rootDir: "/data", files: files("/data/A.xls") }], []);

  expect(await readAll(ORG_ID, [])).toEqual([]);
  expect(await countUnsupportedFiles(ORG_ID, [])).toBe(0);
});

it("never reads another organisation's rows", async () => {
  await recordUnsupportedFiles("org-other", [{ rootDir: "/data", files: files("/data/A.xls") }], []);

  expect(await countUnsupportedFiles(ORG_ID, ["/data"])).toBe(0);
});

// A real share holds 100k+ such files. The read pages through them by path, so
// neither the database nor the route ever holds the whole list at once — and
// paging must neither drop nor repeat a row at a page boundary.
it("pages through a large list without dropping or repeating a row", async () => {
  const many = Array.from(
    { length: 2503 },
    (_, i) => `/data/scans/${String(i).padStart(5, "0")}.tif`
  );
  await recordUnsupportedFiles(ORG_ID, [{ rootDir: "/data", files: files(...many) }], []);

  const read = await readAll(ORG_ID, ["/data"], 1000);

  expect(read.map((f) => f.sourcePath)).toEqual(many);
});
