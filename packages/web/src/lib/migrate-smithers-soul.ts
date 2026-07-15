import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { CURRENT_SOUL_HASH, hashSoul, isPristineShippedSoul } from "@/lib/smithers-soul-history";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";

/**
 * Bring every un-customized Smithers SOUL.md up to the soul this build ships.
 *
 * `createSmithersAgent` writes SOUL.md once, at creation, and until this
 * migration nothing ever rewrote it — so an instance installed before
 * 2026-04-15 still ran a soul that claimed to know the platform from memory and
 * then recited facts that have since gone stale. The docs-driven rewrite and
 * every docs page written since simply never reached those installs: the
 * pinchy-docs plugin was there, but the soul never told Smithers to use it.
 *
 * The hash is the selector, deliberately — see the provenance note in
 * lib/smithers-soul-history.ts for why row data (`isPersonal`, `name`,
 * `avatarSeed`) cannot be trusted for this, and why a byte match is proof that
 * the file came from createSmithersAgent and was never edited.
 *
 * Runs on every boot from bootInits(), behind the isSetupComplete() gate.
 * Idempotent: once a soul is current it hashes to CURRENT_SOUL_HASH and is
 * skipped, so steady-state cost is one file read per agent.
 *
 * Boot budget: everything here happens BEFORE markOpenClawConfigReady(), and
 * compose gives the healthcheck 5s + 30×2s = 65s before Pinchy is declared
 * unhealthy — at which point OpenClaw (depends_on: service_healthy) never
 * starts at all. Steady state is far inside that: the skip path never awaits,
 * so it is N sync reads and hashes. The cost lands on the ONE boot that
 * actually upgrades, which writes an audit row per Smithers sequentially, each
 * taking the audit chain's advisory lock. That is one row per user, so an
 * instance with thousands of users spends seconds, not milliseconds, here. If
 * that budget ever gets tight, batch the audit writes rather than dropping
 * them — a silent upgrade is worse than a slow one.
 */
export async function migrateSmithersSoul(): Promise<void> {
  // No `where` filter: which agents are Smithers is decided by the soul's hash,
  // not by the row.
  const allAgents = await db.query.agents.findMany({
    columns: { id: true, name: true },
  });

  // Correlates every row this sweep emits, so one drill-down query reconstructs
  // the full upgrade (AGENTS.md's batched-maintenance convention).
  const sweepId = randomUUID();

  for (const agent of allAgents) {
    let current: string;
    try {
      current = readWorkspaceFile(agent.id, "SOUL.md");
    } catch (err) {
      // One unreadable workspace must not strand the remaining agents on a
      // stale soul.
      console.error(
        `[pinchy] Could not read SOUL.md for agent ${agent.id}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    // readWorkspaceFile returns "" for a missing file. Either way there is no
    // hash, so no provenance, so nothing we may safely overwrite — and we must
    // not conjure a Smithers soul into an unrelated agent.
    if (!current) continue;

    const previousHash = hashSoul(current);
    if (previousHash === CURRENT_SOUL_HASH) continue;

    // Anything we did not ship is the user's own text. Leave it alone. Raw
    // bytes, no normalization: someone whose editor touched the whitespace is
    // treated as customized and skipped, which is the safe way to be wrong —
    // we never clobber an edit, we only miss a case.
    if (!isPristineShippedSoul(current)) continue;

    try {
      writeWorkspaceFile(agent.id, "SOUL.md", SMITHERS_SOUL_MD);
    } catch (err) {
      // Nothing changed, so there is nothing for the audit trail to record —
      // console.error is how every other bootInits step surfaces failure.
      console.error(
        `[pinchy] Could not upgrade SOUL.md for agent ${agent.id}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "system",
      eventType: "agent.updated",
      resource: `agent:${agent.id}`,
      detail: {
        // Hashes only. The prompt never enters the audit trail, matching the
        // diagnostics collector's instructionsHash rule.
        changes: { "SOUL.md": { from: previousHash, to: CURRENT_SOUL_HASH } },
        agent: { id: agent.id, name: agent.name },
        sweepId,
        reason: "Pinchy-shipped soul upgraded to the version this build ships",
      },
      outcome: "success",
    };

    // The soul is already on disk — a side effect we cannot roll back — so a
    // failed audit write is recorded, not thrown (AGENTS.md's non-request
    // context pattern).
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }
}
