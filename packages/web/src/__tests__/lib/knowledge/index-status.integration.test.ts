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
  opts: { chunks?: boolean; mtime?: Date } = {}
): Promise<void> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: `hash-${sourcePath}`,
      sourcePath,
      mtime: opts.mtime ?? null,
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

/** A job in the given state; `startedAt` an hour ago so files written now count as newer. */
async function seedJob(
  agentId: string,
  paths: string[],
  status: "running" | "succeeded",
  extra: { processed?: number; plan?: { folder: string; files: number }[] } = {}
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
      startedAt: hourAgo,
      finishedAt: status === "succeeded" ? new Date(Date.now() - 60_000) : null,
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

  it("shows a folder as queued while an active run has not finished discovery", async () => {
    const agent = await makeAgent();
    await seedJob(agent.id, ["/kb"], "running");

    const { folders, job } = await getKnowledgeFolderStatus(ORG_ID, agent.id, ["/kb"]);

    expect(folders[0].state).toBe("queued");
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
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    await seedDoc(join(root, "certs", "iso.pdf"), { mtime: new Date() });
    await seedDoc(join(root, "certs", "scan.pdf"), { chunks: false });
    // Indexed two hours ago, modified since — and after the last run started.
    await seedDoc(join(root, "certs", "old.pdf"), { mtime: longAgo });
    await seedJob(agent.id, [root], "succeeded");
    // afnor.pdf has no document: the last run started an hour ago, the file is
    // older than that, so the run saw it and did not get it in.
    await utimes(join(root, "certs", "2024", "afnor.pdf"), longAgo, longAgo);

    const result = await listKnowledgeFolderFiles(ORG_ID, agent.id, [root], {
      folder: join(root, "certs"),
    });

    expect(result).not.toBeNull();
    const states = Object.fromEntries(result!.files.map((f) => [f.name, f.state]));
    expect(states).toEqual({
      "2024/afnor.pdf": "failed",
      "iso.pdf": "searchable",
      "old.pdf": "changed",
      "photo.xyz": "unsupported",
      "scan.pdf": "no_text",
    });
    expect(result!.totals).toEqual({ all: 5, searchable: 2, notSearchable: 3 });
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
    expect(notSearchable!.total).toBe(4);

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
