/**
 * The nightly knowledge-base reindex: the scheduler that turns "it is 02:00 in
 * the org's timezone" into one index job per knowledge-base agent, queued one
 * after another behind the instance's one-job-at-a-time rule.
 *
 * Against a real Postgres, because what matters is the interplay of real rows:
 * the setting the admin saved, the state the scheduler keeps across restarts,
 * the jobs it queues, the partial unique index that refuses a second active
 * job, and the audit rows a run leaves behind. Time is injected (`now`), so
 * every case says exactly which wall-clock moment it is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, auditLog, kbIndexJobs } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import {
  claimNextIndexJob,
  enqueueIndexJob,
  finishIndexJob,
  requeueOrphanedIndexJobs,
} from "@/lib/knowledge/index-jobs";
import {
  getIndexScheduleState,
  saveIndexSchedule,
  saveIndexScheduleState,
} from "@/lib/knowledge/index-schedule-store";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { zeroIngestResult } from "@/lib/knowledge/types";
import type { IngestDeps } from "@/lib/knowledge/ingest";
import { runNextIndexJob, _resetKbIndexWorkerForTest } from "@/server/kb-index-worker";
import {
  runKbIndexSchedulerTick,
  _resetKbIndexSchedulerForTest,
} from "@/server/kb-index-scheduler";

const mockKbEmbedderAvailable = vi.fn(() => true);
vi.mock("@/lib/knowledge/kb-embedder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/kb-embedder")>()),
  kbEmbedderAvailable: () => mockKbEmbedderAvailable(),
}));

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-scheduler-test-"));
  _resetKbIndexSchedulerForTest();
  _resetKbIndexWorkerForTest();
  mockKbEmbedderAvailable.mockReturnValue(true);
  // Vienna, so every case below also proves the scheduler reads the ORG's
  // clock: 02:00 there is 00:00 or 01:00 UTC, never 02:00.
  await setSetting("org.timezone", "Europe/Vienna");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A UTC instant for a Vienna wall-clock time in October 2026 (CEST, UTC+2). */
function vienna(date: string, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCMinutes(h * 60 + m - 120);
  return instant;
}

function folder(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.pdf`), `bytes of ${name}`);
  return dir;
}

async function makeAgent(
  name: string,
  opts: {
    tools?: string[];
    paths?: string[];
    isPersonal?: boolean;
    deleted?: boolean;
  } = {}
) {
  const [agent] = await db
    .insert(agents)
    .values({
      name,
      model: "test-model",
      greetingMessage: "Hi",
      allowedTools: opts.tools ?? ["knowledge_search"],
      pluginConfig: { "pinchy-files": { allowed_paths: opts.paths ?? [folder(name)] } },
      isPersonal: opts.isPersonal ?? false,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning();
  return agent;
}

function fakeDeps(): IngestDeps {
  return {
    embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.01)),
    extractPdf: async () => [{ page: 1, text: "A document about onboarding." }],
    extractXlsx: async () => {
      throw new Error("extractXlsx must not be called for a PDF");
    },
    convertOffice: async () => {
      throw new Error("convertOffice must not be called for a PDF");
    },
  };
}

async function jobs() {
  return db.select().from(kbIndexJobs).orderBy(asc(kbIndexJobs.createdAt));
}

async function reindexAuditRows() {
  return db.select().from(auditLog).where(eq(auditLog.eventType, "knowledge.reindex"));
}

/** Ticks once at 01:00 so the scheduler has seen the night before — the state every steady-state install is in. */
async function settleBefore(date: string) {
  await runKbIndexSchedulerTick({ now: vienna(date, "01:00") });
}

describe("kb index scheduler", () => {
  // An upgrade lands at 10:00 on a working day. The 02:00 slot has passed and
  // was never taken — but treating it as missed would start a full walk of
  // every knowledge base in the middle of the day nobody asked for.
  it("does not run on its first tick, even past the scheduled time", async () => {
    await makeAgent("Handbook");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-19", "10:00") });

    expect(await jobs()).toHaveLength(0);
    expect((await getIndexScheduleState()).lastSlot).toBe("2026-10-19");
  });

  it("queues a scheduled job for a knowledge-base agent when the night's slot comes", async () => {
    const agent = await makeAgent("Handbook");
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    const [job, ...rest] = await jobs();
    expect(rest).toHaveLength(0);
    expect(job).toMatchObject({
      agentId: agent.id,
      agentName: "Handbook",
      orgId: DEFAULT_ORG_ID,
      status: "pending",
      trigger: "scheduled",
      requestedBy: "kb-index-scheduler",
      paths: [join(tmpRoot, "Handbook")],
    });
    expect(job.sweepId).toEqual(expect.any(String));
  });

  it("is still asleep a minute before the slot", async () => {
    await makeAgent("Handbook");
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "01:59") });

    expect(await jobs()).toHaveLength(0);
  });

  // The request half of the two knowledge.reindex rows every run leaves: who
  // asked (the system, not an admin), for which agent, and which night.
  it("audits the request as the system, marked scheduled and tied to the sweep", async () => {
    const agent = await makeAgent("Handbook");
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    const [job] = await jobs();
    const rows = await reindexAuditRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.actorType).toBe("system");
    expect(row.actorId).toBe("kb-index-scheduler");
    expect(row.outcome).toBe("success");
    expect(row.resource).toBe(`agent:${agent.id}`);
    expect(row.detail).toMatchObject({
      agent: { id: agent.id, name: "Handbook" },
      pathCount: 1,
      jobId: job.id,
      trigger: "scheduled",
      sweepId: job.sweepId,
    });
    // A granted folder is a real filesystem path and can embed a username.
    expect(JSON.stringify(row.detail)).not.toContain(tmpRoot);
  });

  // One job at a time across the instance is the rule the whole queue is
  // built on. The sweep honours it by waiting, not by breaking it.
  it("queues the agents one after another, each once the run before it has finished", async () => {
    const first = await makeAgent("Handbook");
    const second = await makeAgent("Contracts");
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:01") });
    expect((await jobs()).map((j) => j.agentId)).toEqual([first.id]);

    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:30") });

    const queued = await jobs();
    expect(queued.map((j) => j.agentId)).toEqual([first.id, second.id]);
    expect(queued.map((j) => j.status)).toEqual(["succeeded", "pending"]);
    // One night, one sweep.
    expect(queued[1].sweepId).toBe(queued[0].sweepId);

    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "03:00") });

    expect(await jobs()).toHaveLength(2);
    expect((await getIndexScheduleState()).sweep).toBeNull();
  });

  // The end-to-end claim the feature makes: a file that lands in the folder
  // during the day is in the index the next morning, and its outcome row says
  // the schedule did it.
  it("indexes what arrived since the last run and audits the outcome as scheduled", async () => {
    const dir = folder("Handbook");
    await makeAgent("Handbook", { paths: [dir] });
    await settleBefore("2026-10-20");
    writeFileSync(join(dir, "new-policy.pdf"), "a document dropped in during the day");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    const ran = await runNextIndexJob({ deps: fakeDeps() });

    expect(ran?.status).toBe("succeeded");
    expect(ran?.counts).toMatchObject({ indexed: 2 });
    const outcome = (await reindexAuditRows()).find((r) => r.actorId === "kb-index-worker");
    expect(outcome?.detail).toMatchObject({ trigger: "scheduled", sweepId: ran?.sweepId });
  });

  /** Finishes a job as of a given wall-clock moment — finishIndexJob stamps the real clock, and these cases run on an injected one. */
  async function finishAt(jobId: string, at: Date, outcome: "succeeded" | "failed" = "succeeded") {
    await finishIndexJob(jobId, { outcome, counts: zeroIngestResult() });
    await db.update(kbIndexJobs).set({ finishedAt: at }).where(eq(kbIndexJobs.id, jobId));
  }

  // An admin started a big reindex of another agent at 01:30. The night's run
  // is delayed by it, not lost to it — and the admin's run is not interrupted.
  it("waits behind a run already in progress instead of dropping the night", async () => {
    const handbook = await makeAgent("Handbook");
    const contracts = await makeAgent("Contracts");
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: contracts.id,
      agentName: contracts.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "Contracts")],
    });
    await claimNextIndexJob();

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual"]);

    await finishAt(manual.job.id, vienna("2026-10-20", "05:11"));
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "05:12") });

    const all = await jobs();
    expect(all.map((j) => [j.agentId, j.trigger])).toEqual([
      [contracts.id, "manual"],
      [handbook.id, "scheduled"],
    ]);
  });

  // The go-live shape: the first full index of a large share runs from 10:00
  // into the next morning. Re-walking that same share the moment it finishes —
  // mid-morning, holding the one job slot for an hour while admins get 409s —
  // buys almost nothing. That run already read the folder; the next night
  // picks up whatever it missed.
  it("skips an agent whose own run finished after the night began", async () => {
    const handbook = await makeAgent("Handbook");
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: handbook.id,
      agentName: handbook.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "Handbook")],
    });
    await claimNextIndexJob();
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    await finishAt(manual.job.id, vienna("2026-10-20", "11:00"));
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "11:01") });

    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual"]);
    expect((await getIndexScheduleState()).sweep).toBeNull();

    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });
    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual", "scheduled"]);
  });

  // The other side of the same rule: a run that finished BEFORE the night
  // began says nothing about what arrived since.
  it("still reindexes an agent whose last run finished before the night began", async () => {
    const handbook = await makeAgent("Handbook");
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: handbook.id,
      agentName: handbook.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "Handbook")],
    });
    await finishAt(manual.job.id, vienna("2026-10-19", "18:00"));

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual", "scheduled"]);
  });

  // The skip is for a run that READ the folders. One that failed at 02:10 on a
  // passing fault read nothing worth trusting, and leaving the agent out would
  // turn one bad minute into a lost night.
  it("still reindexes an agent whose run after the night began failed", async () => {
    const handbook = await makeAgent("Handbook");
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: handbook.id,
      agentName: handbook.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "Handbook")],
    });
    await claimNextIndexJob();
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    await finishAt(manual.job.id, vienna("2026-10-20", "02:10"), "failed");
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:11") });

    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual", "scheduled"]);
  });

  // Reindex now can be narrowed to some of an agent's folders. That run read
  // those folders only; the others still need their night.
  it("still reindexes an agent whose run after the night began covered only some of its folders", async () => {
    const hr = folder("hr");
    const legal = folder("legal");
    const handbook = await makeAgent("Handbook", { paths: [hr, legal] });
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: handbook.id,
      agentName: handbook.name,
      requestedBy: "admin-1",
      paths: [hr],
    });
    await claimNextIndexJob();
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    await finishAt(manual.job.id, vienna("2026-10-20", "03:00"));
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "03:01") });

    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual", "scheduled"]);
  });

  // The go-live shape at full size: the first index of a large share runs
  // past the NEXT night's slot too. When it finally finishes mid-morning, the
  // night it held up is done — and the night it ran through must not start
  // right behind it, re-walking the same share through the working day.
  it("does not start the next night mid-day when the one before drained after its slot", async () => {
    const handbook = await makeAgent("Handbook");
    await settleBefore("2026-10-20");
    const manual = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: handbook.id,
      agentName: handbook.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "Handbook")],
    });
    await claimNextIndexJob();
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });

    await finishAt(manual.job.id, vienna("2026-10-21", "11:00"));
    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "11:01") });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "11:02") });

    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual"]);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-22", "02:00") });
    expect((await jobs()).map((j) => j.trigger)).toEqual(["manual", "scheduled"]);
  });

  // Only an agent that searches the index needs it current, and retrieval is
  // scoped by the SEARCHING agent's grants — so these agents' folders are
  // exactly the ones any search can reach.
  it("sweeps every knowledge-base agent that has folders to index", async () => {
    const kb = await makeAgent("Handbook");
    await makeAgent("No folders", { paths: [] });
    await makeAgent("Reads files, never searches", { tools: [] });
    // Personal or shared makes no difference: an agent that searches the
    // index needs it current either way.
    const own = await makeAgent("Someone's own", { isPersonal: true });
    await makeAgent("Deleted", { deleted: true });
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:30") });
    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "03:00") });

    expect((await jobs()).map((j) => j.agentId)).toEqual([kb.id, own.id]);
    expect((await getIndexScheduleState()).sweep).toBeNull();
  });

  it("runs once a night, however many ticks follow", async () => {
    await makeAgent("Handbook");
    await settleBefore("2026-10-20");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    await runNextIndexJob({ deps: fakeDeps() });
    for (const time of ["02:30", "09:00", "17:45", "23:59"]) {
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", time) });
    }
    expect(await jobs()).toHaveLength(1);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });
    expect(await jobs()).toHaveLength(2);
  });

  // Pinchy was down at 02:00 — a host reboot, an upgrade that ran long. The
  // documents that arrived yesterday are still waiting, so the night runs when
  // Pinchy comes back. Once: not once per missed night.
  it("catches up a night it missed when it comes back", async () => {
    await makeAgent("Handbook");
    await settleBefore("2026-10-18");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "07:00") });
    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "07:30") });

    expect(await jobs()).toHaveLength(1);
  });

  // The process died mid-run. The worker requeues the orphan at boot; the
  // scheduler must neither forget the agents still waiting nor queue the
  // interrupted one a second time.
  it("picks up where it left off after a restart", async () => {
    const first = await makeAgent("Handbook");
    const second = await makeAgent("Contracts");
    await settleBefore("2026-10-20");
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    await claimNextIndexJob(); // running when the process dies

    // Boot.
    _resetKbIndexSchedulerForTest();
    _resetKbIndexWorkerForTest();
    expect(await requeueOrphanedIndexJobs()).toBe(1);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:10") });
    expect((await jobs()).map((j) => j.agentId)).toEqual([first.id]);

    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:40") });
    await runNextIndexJob({ deps: fakeDeps() });
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "03:10") });

    const all = await jobs();
    expect(all.map((j) => j.agentId)).toEqual([first.id, second.id]);
    expect(all.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
  });

  // The narrowest crash: the job row was written, the process died before the
  // scheduler recorded that the agent was done. The job is the evidence.
  it("does not queue an agent twice when the crash came between the job and the bookkeeping", async () => {
    const first = await makeAgent("Handbook");
    const second = await makeAgent("Contracts");
    await settleBefore("2026-10-20");
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });
    const state = await getIndexScheduleState();
    // Roll the bookkeeping back to before the first agent was popped.
    await saveIndexScheduleState({
      ...state,
      sweep: { ...state.sweep!, pending: [first.id, second.id] },
    });
    await runNextIndexJob({ deps: fakeDeps() });

    _resetKbIndexSchedulerForTest();
    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:20") });

    expect((await jobs()).map((j) => j.agentId)).toEqual([first.id, second.id]);
  });

  describe("when the admin changes the schedule", () => {
    it("does nothing while the schedule is off", async () => {
      await makeAgent("Handbook");
      await saveIndexSchedule({ enabled: false, time: "02:00" });
      await settleBefore("2026-10-20");

      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

      expect(await jobs()).toHaveLength(0);
    });

    // The running job finishes — it is already reading the corpus, and an
    // interrupted run is worth less than a finished one. The agents still
    // waiting for tonight are dropped.
    it("drops the rest of a sweep when switched off mid-night", async () => {
      await makeAgent("Handbook");
      await makeAgent("Contracts");
      await settleBefore("2026-10-20");
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

      await saveIndexSchedule({ enabled: false, time: "02:00" });
      await runNextIndexJob({ deps: fakeDeps() });
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:30") });

      expect(await jobs()).toHaveLength(1);
      expect((await getIndexScheduleState()).sweep).toBeNull();
    });

    // Off since last week, switched back on at 14:00. Last night's slot was
    // never taken, but running it now would be a mid-afternoon full walk the
    // admin never asked for: the next run is tonight.
    it("does not fire the moment it is switched back on", async () => {
      await makeAgent("Handbook");
      await saveIndexSchedule({ enabled: false, time: "02:00" });
      await settleBefore("2026-10-13");
      await runKbIndexSchedulerTick({ now: vienna("2026-10-17", "09:00") });

      await saveIndexSchedule({ enabled: true, time: "02:00" });
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "14:00") });
      expect(await jobs()).toHaveLength(0);

      await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });
      expect(await jobs()).toHaveLength(1);
    });

    // The usual way to try the feature out: set it a minute ahead and wait.
    // The scheduler only notices the change on its next tick, which can land
    // after the new time — and must not count today's run as taken because of
    // that, when the screen says "Next run: today at 15:00".
    it("runs today when the time was set just ahead of now, even if the tick that notices lands after it", async () => {
      await makeAgent("Handbook");
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "14:59") });

      await saveIndexSchedule({ enabled: true, time: "15:00" });
      const tickAfterTheTime = new Date(vienna("2026-10-20", "15:00").getTime() + 15_000);
      await runKbIndexSchedulerTick({ now: tickAfterTheTime });

      expect(await jobs()).toHaveLength(1);
    });

    // Moved from 23:00 to 09:00 at 14:00. Today's 09:00 has passed, and today
    // has had no run — but the new time applies from its next occurrence.
    it("applies a new time from its next occurrence, not retroactively", async () => {
      await makeAgent("Handbook");
      await saveIndexSchedule({ enabled: true, time: "23:00" });
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "12:00") });

      await saveIndexSchedule({ enabled: true, time: "09:00" });
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "14:00") });
      await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "23:30") });
      expect(await jobs()).toHaveLength(0);

      await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "09:00") });
      expect(await jobs()).toHaveLength(1);
    });

    // The org timezone moves the clock the slot is read on. Moved from UTC to
    // UTC+14 just after midnight UTC, it is already 14:30 tomorrow there — a
    // date whose 02:00 has passed and was never taken. Still not a reason to
    // start a full walk mid-afternoon.
    it("applies a timezone change from the next occurrence, not retroactively", async () => {
      await makeAgent("Handbook");
      await setSetting("org.timezone", "UTC");
      await runKbIndexSchedulerTick({ now: new Date("2026-10-20T00:00:00Z") });

      await setSetting("org.timezone", "Pacific/Kiritimati");
      await runKbIndexSchedulerTick({ now: new Date("2026-10-20T00:30:00Z") });
      expect(await jobs()).toHaveLength(0);

      // 02:00 on 21 Oct in Kiritimati.
      await runKbIndexSchedulerTick({ now: new Date("2026-10-20T12:00:00Z") });
      expect(await jobs()).toHaveLength(1);
    });
  });

  // Same precheck as the admin's route: queueing a job that can only fail,
  // and finding out from the worker, is worse than saying so now. Said on the
  // record, every night, until somebody fixes the image.
  it("audits a failure and queues nothing when the embedding model is missing", async () => {
    const agent = await makeAgent("Handbook");
    await settleBefore("2026-10-20");
    mockKbEmbedderAvailable.mockReturnValue(false);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "02:00") });

    expect(await jobs()).toHaveLength(0);
    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect(row.actorId).toBe("kb-index-scheduler");
    expect(row.detail).toMatchObject({
      agent: { id: agent.id, name: "Handbook" },
      trigger: "scheduled",
      reason: "embedding_model_missing",
    });
    expect((await getIndexScheduleState()).sweep).toBeNull();
  });

  // A malformed value that sorts after every real date would make `isSlotDue`
  // answer "not yet" forever; one that sorts before would make the night due
  // mid-morning. A date in the future — what a host clock that was briefly
  // wrong (a VM restored from a snapshot) leaves behind — is the first kind.
  // All three are re-taken: no run now, the next night runs.
  it.each([
    ["a malformed last slot that sorts high", "corrupt"],
    ["a malformed last slot that sorts low", "0"],
    ["a last slot in the future", "2027-01-01"],
  ])("recovers from %s instead of waiting for it", async (_label, lastSlot) => {
    await makeAgent("Handbook");
    await saveIndexScheduleState({
      lastSlot,
      schedule: { enabled: true, time: "02:00" },
      timezone: "Europe/Vienna",
      sweep: null,
      lastSweep: null,
    });

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "10:00") });
    expect(await jobs()).toHaveLength(0);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });
    expect(await jobs()).toHaveLength(1);
  });

  // A corrupt state value must cost one night at most — never a mid-day run,
  // and never a scheduler that stops for good.
  it("recovers from state it cannot read without firing", async () => {
    await makeAgent("Handbook");
    await setSetting("knowledge.index_schedule_state", "{not json");

    await runKbIndexSchedulerTick({ now: vienna("2026-10-20", "10:00") });
    expect(await jobs()).toHaveLength(0);

    await runKbIndexSchedulerTick({ now: vienna("2026-10-21", "02:00") });
    expect(await jobs()).toHaveLength(1);
  });
});
