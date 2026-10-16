# Nightly knowledge-base reindex — design

Date: 2026-10-16. Delivers the "automatic re-indexing" item epic #37 closed
with unchecked, and the gap #858 pointed at #714 for. First consumer of the
org timezone (`reference/organization-timezone.mdx` still says nothing uses it).

## Problem

A knowledge base is only as current as its last reindex, and a reindex happens
only when an admin clicks **Reindex now** (or scripts the API). A customer
whose people drop new documents into the mounted folder every day expects them
to become searchable without anyone doing anything. Today they never do.

## What exists and stays

- `kb_index_jobs` + the in-process worker (`src/server/kb-index-worker.ts`):
  claims the oldest pending job, runs `ingestPaths`, audits the outcome,
  requeues orphaned `running` jobs once at boot.
- **One active job per org** (`uq_kb_index_jobs_active`). The manual route
  answers `409` naming the blocking agent. This invariant is not touched.
- Ingest is per-document idempotent by content hash: new → indexed, changed →
  replaced, gone → removed, unchanged → skipped (no extraction, no embedding,
  no OCR). An unreadable root is dropped from the run, so a CIFS hiccup never
  turns into mass deletion.

## Decisions

**In-process scheduler, not OpenClaw cron.** OpenClaw cron (#704) triggers
_agent turns_; a reindex is maintenance inside the web process, next to
upload-gc / audit-verify-job. A 60 s `setInterval`
(`src/server/kb-index-scheduler.ts`), stopped through `buildShutdownSteps`.

**No file watcher.** inotify does not fire on CIFS/SMB mounts, which is
exactly the deployment it would be for. Polling every N minutes would re-read
the corpus that often. The nightly schedule is the mechanism, not a fallback.

**Schedule = one instance-wide setting**, `knowledge.index_schedule` =
`{ enabled, time: "HH:MM" }`, default `{ enabled: true, time: "02:00" }`,
interpreted in the org timezone. Admin-editable on **Settings → Organization**
next to the timezone, via `GET/PUT /api/settings/knowledge-index-schedule`
(audited as `settings.updated` with a from/to diff). On by default: the promise
is "nothing to do", and an off-by-default nightly run would be one more thing
to do.

**Slots are local calendar dates, not instants.** A slot is due when the
org-local time of day has reached `time` and the last slot taken is an earlier
local date. That makes DST a non-event (spring-forward skips 02:00 → it is
03:00 ≥ 02:00, due; fall-back passes 02:00 twice → same date, runs once) with
no zoned→UTC arithmetic. It also gives catch-up for free: Pinchy down at 02:00,
started at 07:00 → the slot is still due, the run happens at 07:00. Only the
latest missed night is caught up, never a backlog.

**First boot and schedule edits never fire immediately.** When there is no
`lastSlot` yet (fresh upgrade), or the admin changes the time, the slot that
has already passed today counts as taken. Upgrading at 10:00 or moving the
time to 09:00 at 14:00 must not start a full corpus walk during working hours.

**Sweeps queue behind the one-job rule instead of changing it.** At the slot,
the scheduler snapshots the eligible agents into a sweep
(`knowledge.index_schedule_state` = `{ lastSlot, sweep: { id, slot,
startedAt, pending: [agentId…] } }`) and enqueues them **one at a time**: each
tick tries `pending[0]`; `busy` (a manual or earlier job holds the slot) means
"try again next tick". A manual run at 02:00 therefore delays the sweep, it
does not lose it; an admin clicking during the sweep gets the existing `409`
naming the scheduled run. Before enqueueing, the scheduler checks whether a
job for `(sweepId, agentId)` already exists — that closes the one crash window
(job inserted, state not yet saved) without a second unique index.

A sweep that is still pending at the next slot is not restarted; the next
sweep begins when it drains. Disabling the schedule drops the pending rest
(the running job finishes).

**Eligible agent** = not deleted, not personal, `knowledge_search` in
`allowedTools`, at least one granted folder. The index is corpus-wide and
retrieval is scoped by the _searching_ agent's grants, so these agents' grants
are exactly the folders any search can reach. Non-KB agents with folders are
not swept (they never read the index). Personal agents are excluded for parity
with the manual route, which no admin can call for one. Paths are resolved at
enqueue time, like the route — a job still snapshots what was authorized when
it was queued.

**Jobs record their trigger.** Migration adds `kb_index_jobs.trigger`
(`manual | scheduled`, default `manual`) and nullable `sweep_id`.
`requested_by` for a scheduled job is the system actor `kb-index-scheduler`.

**Audit.** `reindexAuditEntry` takes a required `trigger` (and optional
`sweepId`), so every call site decides. A scheduled run writes the same two
`knowledge.reindex` rows as a manual one: the request row (actor `system` /
`kb-index-scheduler`, `trigger: "scheduled"`, `sweepId`, `jobId`) and the
worker's outcome row (`trigger` and `sweepId` copied from the job). The
embedder-missing precheck is mirrored from the route: a failure row, no job.

**OCR.** Scheduled jobs run through the same worker, so `resolveKbOcr` — and
`PINCHY_KB_OCR=off` — applies unchanged; no trigger-specific path exists to
forget it. Because unchanged documents are skipped before extraction, a night
only sends pages of _new or changed_ scans. Pinned by a test, documented.

**UI.**

- Settings → Organization: a "Knowledge base indexing" card — checkbox,
  time input, "Next run: tonight at 02:00 (Europe/Vienna)", last sweep.
- Agent → Permissions → Index: one line under the status —
  "Reindexed automatically every night at 02:00 (Europe/Vienna) · next run
  tonight" / "Automatic reindex is off" / for a non-KB agent nothing; the
  finished-run line says "automatically" when the last run was scheduled.
  The agent GET status route carries `trigger` and a `schedule` block.

## Known cost (documented, not changed here)

Every run reads every file once to hash it. On a ~100 GB corpus over SMB that
is the dominant nightly cost (bandwidth, not CPU). An mtime+size fast path
would remove it but changes ingest's change-detection contract; out of scope.

## Out of scope

Per-agent schedules, multiple runs per day, file watching, mtime fast path.
