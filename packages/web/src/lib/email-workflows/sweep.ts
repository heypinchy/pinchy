import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { emailWorkflows } from "@/db/schema";
import type { EmailWorkflowStatus } from "@/db/enums";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { dispatchEmails } from "@/lib/email-workflows/dispatch";
import { resetStuckProcessingEmails } from "@/lib/email-workflows/ledger";
import type { StuckClaimKey } from "@/lib/email-workflows/ledger";
import { listDispatchableEmails } from "@/lib/email-workflows/lister";
import { loadDispatchableWorkflows } from "@/lib/email-workflows/loader";
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

  const units = await loadDispatchableWorkflows();

  // `status` is per workflow, but a unit of work is per (workflow × connection)
  // (D9). Collect each unit's health first and write the column once, so a
  // half-broken workflow reports `error` deterministically instead of taking
  // whichever connection the loader happened to return last.
  const failedWorkflowIds = new Set<string>();
  const seenWorkflowIds = new Set<string>();

  for (const unit of units) {
    seenWorkflowIds.add(unit.workflow.id);
    try {
      const port = await deps.createPort(unit.workflow.connectionId);
      // `folder` only narrows the provider query — the filter re-checks it
      // anyway, so this saves hydrating mail that is guaranteed to be dropped.
      const { emails, candidateCount } = await listDispatchableEmails(port, {
        sinceDays: unit.sweepWindowDays,
        folder: unit.workflow.filter.folder,
        limit: SWEEP_LIST_LIMIT,
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
    } catch (err) {
      // A unit-level failure is a broken *mailbox* (credentials, unreachable
      // host) — invisible in the ledger, because nothing was ever listed. It
      // surfaces as the workflow's health status. One bad mailbox must never
      // stall the rest of the sweep.
      failedWorkflowIds.add(unit.workflow.id);
      console.error(
        `reconciliation sweep: workflow ${unit.workflow.id} failed on connection ${unit.workflow.connectionId}`,
        err
      );
    }
  }

  for (const workflowId of seenWorkflowIds) {
    // Not a latch: a clean pass clears a previous `error`, otherwise any blip
    // would need manual intervention — and the loader deliberately does not gate
    // on `status`, so the workflow would keep running while displaying `error`.
    await setWorkflowStatus(workflowId, failedWorkflowIds.has(workflowId) ? "error" : "active");
  }
}

async function setWorkflowStatus(workflowId: string, status: EmailWorkflowStatus): Promise<void> {
  await db.update(emailWorkflows).set({ status }).where(eq(emailWorkflows.id, workflowId));
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
