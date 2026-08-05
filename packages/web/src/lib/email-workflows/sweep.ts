import { and, eq, inArray, ne } from "drizzle-orm";

import { db } from "@/db";
import { emailWorkflows } from "@/db/schema";
import type { EmailWorkflowStatus } from "@/db/enums";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { dispatchEmails } from "@/lib/email-workflows/dispatch";
import {
  listProcessedProviderMessageIds,
  resetStuckProcessingEmails,
} from "@/lib/email-workflows/ledger";
import type { StuckClaimKey } from "@/lib/email-workflows/ledger";
import { listDispatchableEmails } from "@/lib/email-workflows/lister";
import { loadDispatchableWorkflows } from "@/lib/email-workflows/loader";
import type { DispatchableWorkflow } from "@/lib/email-workflows/loader";
import { DEFAULT_RUN_TIMEOUT_MS } from "@/lib/email-workflows/run-adapter";
import type { EmailPort } from "@/lib/email-workflows/lister";
import type { RunAgent } from "@/lib/email-workflows/dispatch";

/**
 * How long a `processing` claim may sit before the sweep treats it as stuck.
 *
 * This MUST exceed the run timeout, or the sweep would reset live runs out from
 * under themselves and duplicate every slow one. Derived from the run timeout
 * rather than hardcoded so the two cannot drift apart; the 3× headroom covers
 * the notify + finalize tail that follows the run itself.
 */
export const DEFAULT_STUCK_GRACE_MS = 3 * DEFAULT_RUN_TIMEOUT_MS;

/**
 * How many messages one (workflow × connection) pass may hydrate.
 *
 * `sweepWindowDays` bounds the re-list in *time*, not in volume — a busy mailbox
 * holds thousands of messages in 14 days, and the lister hydrates every candidate
 * with a sequential `read()` before the filter drops nearly all of them. This is
 * the volume bound that keeps one noisy mailbox from stalling the whole cadence.
 *
 * It is a safety valve, not a page size: `search` cannot filter by the ledger, so
 * mail beyond the limit is NOT reliably "picked up next pass" — a mailbox that
 * stays saturated may never surface its overflow at all. That is why saturation
 * warns (see below) instead of truncating quietly. The value is deliberately far
 * above a realistic filtered window.
 */
export const SWEEP_LIST_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepDeps {
  /** Builds a mailbox port for one connection, from its decrypted credentials. */
  createPort: (connectionId: string) => Promise<EmailPort>;
  runAgent: RunAgent;
  /** Overrides {@link DEFAULT_STUCK_GRACE_MS}; must exceed the run timeout. */
  graceMs?: number;
}

/**
 * The reconciliation sweep (design §4/§8): re-list each connection's recent mail
 * and dispatch whatever the ledger has not seen. This is the correctness path —
 * the cursor is only an optimization, so a lost or expired cursor costs a resync,
 * never an email.
 */
export async function runReconciliationSweep(deps: SweepDeps): Promise<void> {
  // Free stuck claims BEFORE listing, so an email whose run died is re-listed and
  // retried in this same pass rather than one cadence later. Delete-and-reclaim:
  // the row goes away, the normal claim path re-creates it (#735).
  const reset = await resetStuckProcessingEmails(deps.graceMs ?? DEFAULT_STUCK_GRACE_MS);
  await auditClaimResets(reset, crypto.randomUUID());

  const { units, unrunnable } = await loadDispatchableWorkflows();

  // `status` is per workflow, but a unit of work is per (workflow × connection)
  // (D9). Collect each unit's health first and write the column once, so a
  // half-broken workflow reports `error` deterministically instead of taking
  // whichever connection the loader happened to return last.
  const failedWorkflowIds = new Set<string>();
  const seenWorkflowIds = new Set<string>();

  // A workflow the loader could emit no unit of work for never runs at all:
  // nothing is dispatched, nothing throws, and the pass completes cleanly —
  // while the row stays `enabled: true` and the Automations UI keeps showing it
  // that way. That is a fault, and this is the only place that can say so:
  // `enabled` is the user's intent, `status` is what actually happens to it.
  //
  // Disjoint from `units` by construction — every reason the loader reports is a
  // property of the workflow alone, so a workflow drops on all of its
  // connections or on none — which is why adding to both sets here cannot
  // contradict a healthy unit below.
  const unrunnableById = new Map(unrunnable.map((dropped) => [dropped.workflowId, dropped]));
  for (const workflowId of unrunnableById.keys()) {
    seenWorkflowIds.add(workflowId);
    failedWorkflowIds.add(workflowId);
  }

  for (const unit of units) {
    seenWorkflowIds.add(unit.workflow.id);
    try {
      const port = await deps.createPort(unit.workflow.connectionId);
      try {
        await sweepUnit(unit, port, deps);
      } finally {
        // The port can hold a real connection (IMAP), and this is its only
        // owner — so release it on every path, including the dead-mailbox throw
        // below, which would otherwise strand a connection every cadence.
        // A close failure must NOT fail a unit whose work already succeeded
        // (ledger written, runs done): log it and move on.
        try {
          await port.close?.();
        } catch (closeErr) {
          console.error(
            `reconciliation sweep: failed to close the port for connection ${unit.workflow.connectionId}`,
            closeErr
          );
        }
      }
    } catch (err) {
      // A unit-level failure is a broken *mailbox* (credentials, unreachable
      // host) — invisible in the ledger, because nothing was ever listed. It
      // surfaces as the workflow's health status. One bad mailbox must never
      // stall the rest of the sweep.
      failedWorkflowIds.add(unit.workflow.id);
      // The name is snapshotted beside the id, same rule as an audit row
      // (AGENTS.md): an id alone sends the reader to the database to find out
      // which automation broke, and to nothing at all once it is deleted.
      console.error(
        `reconciliation sweep: workflow ${unit.workflow.id} ("${unit.workflow.name}") failed on connection ${unit.workflow.connectionId}`,
        err
      );
    }
  }

  for (const workflowId of seenWorkflowIds) {
    // Not a latch: a clean pass clears a previous `error`, otherwise any blip
    // would need manual intervention — and the loader deliberately does not gate
    // on `status`, so the workflow would keep running while displaying `error`.
    const changed = await setWorkflowStatus(
      workflowId,
      failedWorkflowIds.has(workflowId) ? "error" : "active"
    );
    const dropped = unrunnableById.get(workflowId);
    // Only on the transition. This sweep runs every minute and a workflow that
    // cannot run will not fix itself, so a line per pass is ~1400 identical
    // lines a day per broken workflow — volume that gets a logger filtered out
    // rather than read. The durable trace is the `status` column (and the badge
    // the UI renders from it); this line only timestamps the moment it changed.
    //
    // The cost of keying on the transition: a workflow already sitting at
    // `error` for a broken mailbox, which then loses its recipient, changes
    // cause without changing status and so is not re-logged. It still reads
    // `error`, which is the claim that matters.
    //
    // `error`, not `warn`, and deliberately: the broken-mailbox failure above
    // logs at error on every single pass, while this one logs once in the
    // workflow's lifetime. The quieter signal must not also be the lower
    // severity, or an operator filtering on error sees the loud fault and never
    // the silent one.
    if (changed && dropped) {
      console.error(
        `reconciliation sweep: workflow ${dropped.workflowId} ("${dropped.name}") on agent ` +
          `${dropped.agentId} is enabled but cannot run (${dropped.reason}) — it is marked ` +
          `error and dispatches nothing until that is fixed`
      );
    }
  }
}

/** One (workflow × connection) pass over an already-open port. */
async function sweepUnit(
  unit: DispatchableWorkflow,
  port: EmailPort,
  deps: SweepDeps
): Promise<void> {
  // Two provider-load optimizations, neither of which touches correctness — both
  // only avoid work whose result the sweep would discard anyway. They are what
  // let this sweep run on a short cadence (the low-latency path) instead of only
  // as an infrequent backstop.
  //
  // 1. Cap the listing window at the watermark's age. The sweep drops everything
  //    below `sinceTs`, so listing further back than that only hydrates mail it
  //    will discard — ruinous every pass for a workflow freshly attached to an
  //    old mailbox. `min(N, ageInDays)` never shortens the window below the
  //    configured N (an old watermark ⟹ full window, design §5's backstop), and
  //    the ceil keeps the bound at/above `sinceTs` so the precise watermark
  //    filter below still trims the day-granularity overlap.
  const watermarkAgeDays = Math.max(1, Math.ceil((Date.now() - unit.sinceTs.getTime()) / DAY_MS));
  const sinceDays = Math.min(unit.sweepWindowDays, watermarkAgeDays);
  // `folder` only narrows the provider query — the filter re-checks it
  // anyway, so this saves hydrating mail that is guaranteed to be dropped.
  const { emails, candidateCount } = await listDispatchableEmails(port, {
    sinceDays,
    folder: unit.workflow.filter.folder,
    limit: SWEEP_LIST_LIMIT,
    // 2. Skip hydrating candidates the ledger already holds. Stuck rows were
    //    DELETEd at the top of the sweep (before any unit lists), so a reset
    //    email is absent here and correctly re-hydrated this same pass; only
    //    genuinely-accounted-for mail is skipped.
    resolveAlreadyProcessed: (candidateIds) =>
      listProcessedProviderMessageIds(unit.workflow.id, unit.workflow.connectionId, candidateIds),
  });
  // A full page means the window held at least as much mail as we are willing
  // to hydrate, so this pass saw a truncated mailbox. Say so: the overflow is
  // not merely deferred (see SWEEP_LIST_LIMIT), and a component whose whole
  // job is "never lose an email" must not truncate in silence.
  //
  // Read the CANDIDATE count, not `emails.length`: the lister drops messages
  // it cannot hydrate, so a full page with one poison mail yields LIMIT-1
  // emails — and gating on the hydrated count would fall silent on exactly
  // the pass that is both truncated and lossy.
  if (candidateCount >= SWEEP_LIST_LIMIT) {
    console.warn(
      `reconciliation sweep: hit the listing limit of ${SWEEP_LIST_LIMIT} for workflow ${unit.workflow.id} on connection ${unit.workflow.connectionId} — mail beyond it was not seen this pass`
    );
  }
  // The sweep re-lists a whole window, so it is the only place the per-
  // (workflow × connection) watermark can be enforced: the lister speaks
  // `sinceDays` and nothing downstream reads `receivedAt`. Without this gate
  // a workflow attached to an old mailbox would retroactively act on the
  // entire window (design §8, "New workflow on old mailbox"). Below the
  // watermark is dropped before the claim, never claimed-and-skipped.
  const fresh = emails.filter((email) => email.receivedAt >= unit.sinceTs);
  await dispatchEmails({ workflow: unit.workflow, emails: fresh, runAgent: deps.runAgent });
}

/**
 * Write the health status, and report whether it actually changed.
 *
 * The write is conditional on the value differing, which buys two things. An
 * unchanged state is not an event — the automations PATCH route already treats
 * a no-op toggle that way — and this sweep runs every minute, so an
 * unconditional write would rewrite every workflow row ~1400 times a day to
 * store the value it already held. The returned flag is what lets a permanent
 * fault be logged once instead of once per pass.
 */
async function setWorkflowStatus(
  workflowId: string,
  status: EmailWorkflowStatus
): Promise<boolean> {
  const changed = await db
    .update(emailWorkflows)
    .set({ status })
    .where(and(eq(emailWorkflows.id, workflowId), ne(emailWorkflows.status, status)))
    .returning({ id: emailWorkflows.id });
  return changed.length > 0;
}

/**
 * One audit row per freed claim, all sharing `sweepId` so a single sweep is one
 * drill-down query. Deleting a ledger row is the sweep's only destructive act,
 * and the only way an email gets processed twice — the trail has to explain it.
 *
 * The workflow *name* is snapshotted beside the id (AGENTS.md): the row must
 * still read sensibly after a rename or a delete, when the id resolves to
 * nothing. Deleting a workflow cascades its ledger rows away, so an unresolvable
 * name here is near-impossible (a delete racing this query) — the fallback keeps
 * the trail honest rather than dropping the row.
 */
async function auditClaimResets(reset: StuckClaimKey[], sweepId: string): Promise<void> {
  if (reset.length === 0) return;

  const names = new Map(
    (
      await db
        .select({ id: emailWorkflows.id, name: emailWorkflows.name })
        .from(emailWorkflows)
        .where(inArray(emailWorkflows.id, [...new Set(reset.map((r) => r.workflowId))]))
    ).map((row) => [row.id, row.name])
  );

  for (const claim of reset) {
    const entry = {
      eventType: "inbox.claim_reset" as const,
      actorType: "system" as const,
      actorId: "inbox-sweep",
      outcome: "success" as const,
      detail: {
        workflow: { id: claim.workflowId, name: names.get(claim.workflowId) ?? "(deleted)" },
        connectionId: claim.connectionId,
        providerMessageId: claim.providerMessageId,
        sweepId,
      },
    };
    // Never fire-and-forget, and never let an audit outage abort the sweep: the
    // reset already happened, so the write is recorded for retry instead.
    try {
      await appendAuditLog(entry);
    } catch (auditErr) {
      recordAuditFailure(auditErr, entry);
    }
  }
}
