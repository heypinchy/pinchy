/**
 * Real-DB integration tests for the folder status and the per-folder file list
 * (#1386). The counts are SQL — a grouping that keys a file by the wrong
 * segment, or a filter that reaches into a sibling folder, still returns
 * plausible numbers from a mock — so they are pinned against Postgres.
 */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, kbChunks, kbDocuments, kbIndexJobs } from "@/db/schema";
import type { FolderPlanSegment } from "@/lib/knowledge/folder-plan";
import { enqueueIndexJob, recordIndexJobFolderPlan } from "@/lib/knowledge/index-jobs";
import { getKnowledgeFolderStatus, listKnowledgeFolderFiles } from "@/lib/knowledge/index-status";

const ORG_ID = "org-kb-index-status-test";

async function makeAgent() {
  const [agent] = await db
    .insert(agents)
    .values({ name: "Smithers", model: "test-model", greetingMessage: "Hi" })
    .returning();
  return agent;
}

async function seedDoc(
  sourcePath: string,
  opts: { chunks?: boolean; mtime?: Date; status?: "active" | "archived" } = {}
): Promise<void> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: `hash-${sourcePath}`,
      sourcePath,
      mtime: opts.mtime ?? null,
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning();
  if (opts.chunks ?? true) {
    await db.insert(kbChunks).values({
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath,
      chunkText: "Text.",
      locator: { kind: "page", page: 1 },
    });
  }
}

/** A job in the given state; `startedAt` an hour ago (unless given) so files written now count as newer. */
async function seedJob(
  agentId: string,
  paths: string[],
  status: "running" | "succeeded" | "failed",
  extra: { processed?: number; plan?: FolderPlanSegment[]; startedAt?: Date } = {}
) {
  const { job } = await enqueueIndexJob({
    orgId: ORG_ID,
    agentId,
    agentName: "Smithers",
    paths,
    requestedBy: "admin-1",
  });
  const hourAgo = new Date(Date.now() - 3_600_000);
  await db
    .update(kbIndexJobs)
    .set({
      status,
      processed: extra.processed ?? 0,
      startedAt: extra.startedAt ?? hourAgo,
      finishedAt: status === "running" ? null : new Date(Date.now() - 60_000),
    })
    .where(eq(kbIndexJobs.id, job.id));
  if (extra.plan) await recordIndexJobFolderPlan(job.id, extra.plan);
  return job;
}

beforeEach(async () => {
  await db.delete(kbIndexJobs);
});

describe("getKnowledgeFolderStatus", () => {
  it("counts documents per granted folder and per immediate subfolder", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/handbook.pdf");
    await seedDoc("/kb/certs/iso.pdf");
    await seedDoc("/kb/certs/2024/afnor.pdf", { chunks: false });
    await seedDoc("/kb-other/not-granted.pdf");

    const { folders, job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(job).toBeNull();
    expect(folders).toHaveLength(1);
    const [root] = folders;
    expect(root).toMatchObject({ path: "/kb", indexed: 3, searchable: 2, notSearchable: 1 });
    expect(root.children).toEqual([
      expect.objectContaining({
        path: "/kb/certs",
        name: "certs",
        indexed: 2,
        notSearchable: 1,
        state: "has_errors",
      }),
    ]);
  });

  // The case #1386 is about: a finished run found 3 files under certs, the
  // index holds 1. Reading only the index, that folder looks complete.
  it("reports a folder with fewer documents than the last run found as having errors", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/a.pdf");
    await seedDoc("/kb/certs/iso.pdf");
    await seedJob(agent.id, ["/kb"], "succeeded", {
      plan: [
        { folder: "/kb", files: 1 },
        { folder: "/kb/certs", files: 3 },
      ],
    });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const certs = folders[0].children.find((c) => c.name === "certs")!;

    expect(certs).toMatchObject({ indexed: 1, expected: 3, pending: 0, state: "has_errors" });
    expect(certs.lastIndexedAt).not.toBeNull();
    expect(folders[0]).toMatchObject({ expected: 4, state: "has_errors" });
  });

  it("names the folder an active run is in and queues the ones after it", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/hr/1.pdf");
    await seedJob(agent.id, ["/kb"], "running", {
      processed: 2,
      plan: [
        { folder: "/kb/hr", files: 2 },
        { folder: "/kb/legal", files: 3 },
        { folder: "/kb/sales", files: 1 },
      ],
    });

    const { folders, job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const byName = Object.fromEntries(folders[0].children.map((c) => [c.name, c]));

    expect(job).toMatchObject({ status: "running", currentFolder: "/kb/legal" });
    // legal and sales have no documents yet; they appear because the plan names them.
    expect(byName.legal).toMatchObject({ state: "indexing", pending: 3, expected: 3 });
    expect(byName.sales).toMatchObject({ state: "queued", pending: 1 });
    expect(folders[0].state).toBe("indexing");
  });

  // #1405: a first index reads archives last. A folder whose current files
  // are all in is searchable, with its archive still to come reported apart.
  it("reports a folder with only its archive left as searchable, archive pending", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/certs/iso.pdf");
    await seedDoc("/kb/certs/din.pdf");
    await seedJob(agent.id, ["/kb"], "running", {
      processed: 3,
      plan: [
        { folder: "/kb/certs", files: 2 },
        { folder: "/kb/legal", files: 2 },
        { folder: "/kb/certs", files: 3, archived: true },
        { folder: "/kb/legal", files: 1, archived: true },
      ],
    });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const byName = Object.fromEntries(folders[0].children.map((c) => [c.name, c]));

    expect(byName.certs).toMatchObject({
      state: "searchable",
      expected: 5,
      expectedArchived: 3,
      pending: 3,
      pendingArchived: 3,
      indexingArchive: false,
    });
    // The run is still in legal's current files.
    expect(byName.legal).toMatchObject({
      state: "indexing",
      pending: 2,
      pendingArchived: 1,
      indexingArchive: false,
    });
    expect(folders[0].state).toBe("indexing");
  });

  it("keeps a folder searchable while the run reads its archive", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/certs/iso.pdf");
    // The run has read the first archived file too, and is on the second.
    await seedDoc("/kb/certs/OLD/2019.pdf");
    await seedJob(agent.id, ["/kb"], "running", {
      processed: 2,
      plan: [
        { folder: "/kb/certs", files: 1 },
        { folder: "/kb/certs", files: 3, archived: true },
      ],
    });

    const { folders, job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const certs = folders[0].children.find((c) => c.name === "certs")!;

    expect(job?.currentFolder).toBe("/kb/certs");
    expect(certs).toMatchObject({
      state: "searchable",
      pending: 2,
      pendingArchived: 2,
      indexingArchive: true,
    });
    expect(folders[0]).toMatchObject({ state: "searchable", indexingArchive: true });
  });

  // A run re-reads archived files last. Until it is through them, the state
  // speaks for the current files alone: an archived document waiting for
  // conversion, or one without text, is the archive's to report once read.
  it("leaves archived documents out of the state until the run has read them", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/certs/iso.pdf");
    // No artifact format recorded: read from an earlier conversion.
    await seedDoc("/kb/certs/OLD/2019.docx", { status: "archived" });
    await seedDoc("/kb/legal/nda.pdf");
    await seedDoc("/kb/legal/OLD/scan.pdf", { status: "archived", chunks: false });
    const plan: FolderPlanSegment[] = [
      { folder: "/kb/certs", files: 1 },
      { folder: "/kb/legal", files: 1 },
      { folder: "/kb/certs", files: 1, archived: true },
      { folder: "/kb/legal", files: 1, archived: true },
    ];
    await seedJob(agent.id, ["/kb"], "running", { processed: 2, plan });

    const during = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const duringByName = Object.fromEntries(during.folders[0].children.map((c) => [c.name, c]));
    expect(duringByName.certs).toMatchObject({ state: "searchable", notSearchable: 1 });
    expect(duringByName.legal).toMatchObject({ state: "searchable", notSearchable: 1 });

    // The run is over; the scan still holds no text.
    await seedJob(agent.id, ["/kb"], "succeeded", { processed: 4, plan });
    const after = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const afterByName = Object.fromEntries(after.folders[0].children.map((c) => [c.name, c]));
    expect(afterByName.legal).toMatchObject({ state: "has_errors", notSearchable: 1 });
  });

  // While the archive is still to come, the tree counts the current files
  // alone, so it needs to know which documents are archived.
  it("counts archived documents apart from the current ones", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/certs/iso.pdf");
    await seedDoc("/kb/certs/scan.pdf", { chunks: false });
    await seedDoc("/kb/certs/OLD/2019.pdf", { status: "archived" });
    await seedDoc("/kb/certs/OLD/2018.pdf", { status: "archived" });
    await seedDoc("/kb/certs/OLD/fax.pdf", { status: "archived", chunks: false });
    // Waits for conversion: not searchable either.
    await seedDoc("/kb/certs/OLD/2017.docx", { status: "archived" });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const certs = folders[0].children.find((c) => c.name === "certs")!;

    expect(certs).toMatchObject({
      indexed: 6,
      searchable: 3,
      notSearchable: 3,
      archivedSearchable: 2,
      archivedNotSearchable: 2,
    });
    expect(folders[0]).toMatchObject({ archivedSearchable: 2, archivedNotSearchable: 2 });
  });

  it("shows a folder as queued while an active run has not finished discovery", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb"], "running");

    const { folders, job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(folders[0].state).toBe("queued");
    expect(job?.currentFolder).toBeNull();
  });

  // Saving a new grant starts no run. Until one looks at the folder, the last
  // run's plan says nothing about it — and "nothing" is not "empty".
  it("reports a folder the last planned run did not cover as not indexed, not empty", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb"], "succeeded", { plan: [{ folder: "/kb", files: 2 }] });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb", "/kb-new"]);
    const added = folders.find((f) => f.path === "/kb-new")!;

    expect(added).toMatchObject({ expected: null, state: "not_indexed" });
  });

  // After narrowing a grant from /kb to /kb/certs, the old plan counted the
  // whole of certs as one folder: it cannot say how many files each of the
  // new root's children holds.
  it("gives no expected count to a folder an older plan counted only as part of a parent", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/certs/2024/a.pdf");
    await seedJob(agent.id, ["/kb"], "succeeded", { plan: [{ folder: "/kb/certs", files: 5 }] });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb/certs"]);
    const child = folders[0].children.find((c) => c.name === "2024")!;

    expect(child).toMatchObject({ expected: null, state: "searchable" });
  });

  // A run whose every root was unreadable (an unmounted share) records an
  // empty plan. It must not wipe what the run before it found.
  it("ignores the empty plan of a failed run", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb"], "succeeded", { plan: [{ folder: "/kb", files: 3 }] });
    await seedJob(agent.id, ["/kb"], "failed", { plan: [] });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(folders[0]).toMatchObject({ expected: 3, state: "has_errors" });
  });

  // A run that succeeds can still skip a folder it found empty (an unmounted
  // share below the grant) and keep its documents. The plan then holds nothing
  // for that folder, so it can't say how many files are there, and the run
  // didn't look at them: no "0 expected", no "indexed today".
  it("claims no count or date from a run for a folder it kept without looking", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/a.pdf");
    await seedDoc("/kb/finance/1.pdf");
    await seedDoc("/kb/finance/2.pdf");
    await seedJob(agent.id, ["/kb"], "succeeded", { plan: [{ folder: "/kb", files: 1 }] });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);
    const finance = folders[0].children.find((c) => c.name === "finance")!;

    expect(finance).toMatchObject({ expected: null, indexed: 2, state: "searchable" });
    expect(Date.parse(finance.lastIndexedAt!)).toBeGreaterThan(Date.now() - 30_000);
    expect(folders[0]).toMatchObject({ expected: null, indexed: 3 });
    // The root's other files were read by the run: it keeps the run's date.
    expect(Date.parse(folders[0].lastIndexedAt!)).toBeLessThan(Date.now() - 30_000);
  });

  // A run that fails removes nothing, so its plan can find fewer files than the
  // index still holds after files were deleted. The plan is still a fresh count.
  it("keeps a failed run's count for a folder whose files were deleted since", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/a.pdf");
    await seedDoc("/kb/b.pdf");
    await seedJob(agent.id, ["/kb"], "failed", { plan: [{ folder: "/kb", files: 1 }] });

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(folders[0]).toMatchObject({ expected: 1, indexed: 2 });
  });

  // A failed run may have read nothing; it must not date every folder today.
  it("dates a folder by the last run that succeeded, not by one that failed", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb"], "failed");

    const { folders } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(folders[0].lastIndexedAt).toBeNull();
  });

  // The plan is built from the paths the run snapshotted. A folder removed from
  // the grants mid-run must not stay on screen as "the folder it is in".
  it("does not name a current folder outside the agent's present grants", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb", "/hr"], "running", {
      processed: 0,
      plan: [{ folder: "/hr/salaries", files: 2 }],
    });

    const { job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(job?.currentFolder).toBeNull();
  });

  it("answers nothing for an agent without grants", async () => {
    const agent = await makeAgent();
    await seedDoc("/kb/a.pdf");

    expect(await getKnowledgeFolderStatus(ORG_ID, agent.id, [])).toEqual({
      folders: [],
      job: null,
    });
  });
});

describe("listKnowledgeFolderFiles", () => {
  let root: string;

  beforeEach(async () => {
    // realpath: macOS's tmpdir is a symlink, and the listing resolves real paths.
    root = realpathSync(await mkdtemp(join(tmpdir(), "kb-index-status-")));
    await mkdir(join(root, "certs", "2024"), { recursive: true });
    await writeFile(join(root, "handbook.pdf"), "x");
    await writeFile(join(root, "certs", "iso.pdf"), "x");
    await writeFile(join(root, "certs", "2024", "afnor.pdf"), "x");
    await writeFile(join(root, "certs", "scan.pdf"), "x");
    await writeFile(join(root, "certs", "old.pdf"), "x");
    await writeFile(join(root, "certs", "photo.xyz"), "x");
    await writeFile(join(root, "certs", ".hidden.pdf"), "x");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("gives each file below a subfolder its state", async () => {
    const agent = await makeAgent();
    await writeFile(join(root, "certs", "prices.xlsb"), "x");
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    await seedDoc(join(root, "certs", "iso.pdf"), { mtime: new Date() });
    await seedDoc(join(root, "certs", "scan.pdf"), { chunks: false });
    // Indexed two hours ago, modified since — and after the last run started.
    await seedDoc(join(root, "certs", "old.pdf"), { mtime: longAgo });
    await seedJob(agent.id, [root], "succeeded");
    // afnor.pdf has no document and an old modification time — but a copy
    // that keeps mtime (cp -p, rsync -a, a restored backup) still arrived
    // now, which its ctime records. The last run cannot have seen it.
    await utimes(join(root, "certs", "2024", "afnor.pdf"), longAgo, longAgo);

    const result = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
    });

    expect(result).not.toBeNull();
    const states = Object.fromEntries(result!.files.map((f) => [f.name, f.state]));
    expect(states).toEqual({
      "2024/afnor.pdf": "new",
      "iso.pdf": "searchable",
      "old.pdf": "changed",
      // #1410: a type we have no name for is not a document; an .xlsb is
      // one the index can't read yet.
      "photo.xyz": "ignored",
      "prices.xlsb": "unsupported",
      "scan.pdf": "no_text",
    });
    // `all` counts the files the index reads; the other two are counted apart.
    expect(result!.totals).toEqual({
      all: 4,
      searchable: 2,
      notSearchable: 2,
      unsupported: 1,
      ignored: 1,
    });
  });

  it("marks a file the last run saw but did not get in as failed", async () => {
    const agent = await makeAgent();
    // The run started after every file here arrived, so it walked past them.
    await seedJob(agent.id, [root], "succeeded", { startedAt: new Date(Date.now() + 5_000) });

    const result = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], { folder: root });

    expect(result!.files.map((f) => [f.name, f.state])).toEqual([["handbook.pdf", "failed"]]);
  });

  // A root can also be a child row of a shallower root (/data and /data/hr
  // both granted). The child row counts its whole subtree, so its file list
  // must too; the root row lists only its own files.
  it("lists a whole subtree or only direct files, as asked", async () => {
    const agent = await makeAgent();

    const tree = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: root,
      scope: "tree",
    });
    expect(tree!.files.map((f) => f.name)).toContain("certs/2024/afnor.pdf");

    const direct = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
      scope: "direct",
    });
    expect(direct!.files.map((f) => f.name)).toEqual([
      "iso.pdf",
      "old.pdf",
      "photo.xyz",
      "scan.pdf",
    ]);
  });

  it("lists only the files directly in a granted folder", async () => {
    const agent = await makeAgent();

    const result = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], { folder: root });

    expect(result!.files.map((f) => [f.name, f.state])).toEqual([["handbook.pdf", "new"]]);
  });

  it("filters to files search cannot use, searches by name, and paginates", async () => {
    const agent = await makeAgent();
    await seedDoc(join(root, "certs", "iso.pdf"));

    const notSearchable = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
      filter: "not_searchable",
    });
    expect(notSearchable!.files.map((f) => f.name)).not.toContain("iso.pdf");
    // A file type the index does not read is not "not searchable yet".
    expect(notSearchable!.files.map((f) => f.name)).not.toContain("photo.xyz");
    expect(notSearchable!.total).toBe(3);

    const searched = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
      q: "AFN",
    });
    expect(searched!.files.map((f) => f.name)).toEqual(["2024/afnor.pdf"]);

    const page = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
      offset: 1,
      limit: 2,
    });
    expect(page!.files.map((f) => f.name)).toEqual(["iso.pdf", "old.pdf"]);
    expect(page!.total).toBe(5);
  });

  it("marks a file without a document as pending while a run covers it", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, [root], "running");

    const result = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], { folder: root });

    expect(result!.files[0].state).toBe("pending");
  });

  // The folder comes from the query string. Outside the grants — or climbing
  // out of them — it must read as not found, never as an empty folder.
  it("refuses a folder outside the agent's grants", async () => {
    const agent = await makeAgent();

    for (const folder of [
      "/etc",
      `${root}-sibling`,
      join(root, "certs", "..", ".."),
      `${root}/certs/../../`,
      join(root, "missing"),
    ]) {
      expect(
        await listKnowledgeFolderFiles(ORG_ID, agent.id, [join(root, "certs")], { folder })
      ).toBeNull();
    }
  });

  // Ingest skips hidden and OS-junk folders, and pinchy-files refuses any
  // hidden path segment. A Samba recycle bin keeps deleted files under their
  // old names: naming it in the query string must not list it.
  it("refuses a hidden or denylisted folder inside the grant, and a hidden file", async () => {
    const agent = await makeAgent();
    await mkdir(join(root, ".recycle", "hr"), { recursive: true });
    await writeFile(join(root, ".recycle", "hr", "deleted.pdf"), "x");
    await mkdir(join(root, "$RECYCLE.BIN"), { recursive: true });
    await writeFile(join(root, "$RECYCLE.BIN", "gone.pdf"), "x");

    for (const folder of [
      join(root, ".recycle"),
      join(root, ".recycle", "hr"),
      join(root, "$RECYCLE.BIN"),
      join(root, "certs", ".hidden.pdf"),
    ]) {
      expect(await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], { folder })).toBeNull();
    }
  });

  // A folder spelled with `.` or `//` passes a prefix test but is not the
  // path the listing builds, so offsets computed from it point elsewhere.
  it("refuses a folder that is not written in its normal form", async () => {
    const agent = await makeAgent();

    for (const folder of [`${root}/.`, `${root}//certs`, `${root}/certs/./2024`]) {
      expect(await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], { folder })).toBeNull();
    }
  });

  it("refuses a link inside the grant that points outside it", async () => {
    const agent = await makeAgent();
    const outside = realpathSync(await mkdtemp(join(tmpdir(), "kb-outside-")));
    await writeFile(join(outside, "secret.pdf"), "x");
    await symlink(outside, join(root, "certs", "escape"));

    try {
      expect(
        await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
          folder: join(root, "certs", "escape"),
        })
      ).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
