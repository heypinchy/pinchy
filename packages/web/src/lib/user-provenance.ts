import { and, asc, eq, ne, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, invites, auditLog } from "@/db/schema";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

/**
 * Where an account came from.
 *
 * Pinchy creates accounts in exactly two places, in every release since
 * v0.1.0: the setup wizard (the first admin, `lib/setup.ts#createAdmin`) and a
 * claimed invite (`app/api/invite/claim`, which records the new account in
 * `invites.claimed_by_user_id` on a `type = 'invite'` row). Releases up to and
 * including v0.9.1 also left Better Auth's `/sign-up/email` open to clients, so
 * anyone who could reach the instance could register a member. Closing the
 * endpoint does nothing to those accounts — password sign-in still works — so
 * this module finds them.
 *
 * The rule: an account is of unknown origin unless it is
 *
 *   - the setup admin — the EARLIEST-CREATED account that holds the admin role.
 *     Not simply the earliest account: a public instance accepted sign-ups
 *     before the wizard ran, and sign-up only ever produced members. Setup is
 *     not otherwise recorded for installs older than the `user.created` row;
 *   - the claimer of an invite of type `invite`. A claimed `reset` invite is
 *     issued for an account that already exists, so it explains nothing;
 *   - the creator of any invite (`invites.created_by`). Only admins can create
 *     one, and the column is never rewritten, so it still vouches for a setup
 *     admin who was later demoted;
 *   - or an account an admin marked as known: a successful
 *     `user.origin_acknowledged` audit row for it, written by
 *     `POST /api/users/:id/acknowledge-origin`. That is the way out of every
 *     over-report below, and it works on the admin's own account too.
 *
 * Known limits. Nothing is acted on automatically — an admin reviews the
 * list — so these mostly over-report:
 *
 *   - a setup admin who was later demoted and never created an invite is
 *     flagged, because the earliest remaining admin is then someone else;
 *   - an invite deleted after it was claimed (only possible by calling
 *     `DELETE /api/users/invites/:id` directly — the UI lists pending invites
 *     only) or removed with its inviter (`invites.created_by` cascades on a
 *     hard user delete, which Pinchy itself never does);
 *   - a claim that crashed between creating the account and marking the
 *     invite claimed.
 *
 * And it under-reports a self-registered account that an admin later promoted,
 * in two ways, because both rules that vouch for admins read the role as it is
 * now:
 *
 *   - it passes as the setup admin when it is the earliest admin left — it
 *     signed up before setup ran and was promoted, or the real setup admin was
 *     demoted. The rule cannot tell, and nothing demotes it;
 *   - it passes once it has created an invite, which any admin can.
 *
 * Both need an admin to have promoted the account first, so an admin has
 * already vouched for it once — the `user.role_updated` row records who.
 */
export interface UnknownOriginUser {
  id: string;
  name: string;
  role: string;
  banned: boolean;
  createdAt: Date;
}

export const UNKNOWN_ORIGIN_EVENT = "user.unknown_origin_detected" as const;
export const ORIGIN_ACKNOWLEDGED_EVENT = "user.origin_acknowledged" as const;

async function findSetupAdminId(): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return row?.id ?? null;
}

export async function findUnknownOriginUsers(): Promise<UnknownOriginUser[]> {
  const setupAdminId = await findSetupAdminId();

  const noClaimedInvite = notExists(
    db
      .select({ one: sql`1` })
      .from(invites)
      .where(and(eq(invites.claimedByUserId, users.id), eq(invites.type, "invite")))
  );
  const noInviteCreated = notExists(
    db
      .select({ one: sql`1` })
      .from(invites)
      .where(eq(invites.createdBy, users.id))
  );
  // The acknowledgement lives in the audit trail, not in a column: the row is
  // both the record of who vouched for the account and the state itself, and
  // it is append-only, so no later write can quietly undo it. Served by
  // idx_audit_resource_timestamp.
  const notAcknowledged = notExists(
    db
      .select({ one: sql`1` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource, sql`'user:' || ${users.id}`),
          eq(auditLog.eventType, ORIGIN_ACKNOWLEDGED_EVENT),
          eq(auditLog.outcome, "success")
        )
      )
  );
  const unexplained = and(noClaimedInvite, noInviteCreated, notAcknowledged);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      banned: users.banned,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(setupAdminId ? and(unexplained, ne(users.id, setupAdminId)) : unexplained)
    .orderBy(asc(users.createdAt), asc(users.id));

  return rows.map((r) => ({ ...r, banned: r.banned ?? false }));
}

/** Rows written between yields to the event loop; see reportUnknownOriginUsers. */
export const REPORT_BATCH_SIZE = 200;

/**
 * Write one `user.unknown_origin_detected` audit row for every unknown-origin
 * account that has none yet. Runs at boot (lib/boot-inits.ts), after readiness
 * and detached from it, so the upgrade that closes the sign-up endpoint is also
 * the moment those accounts show up in the audit trail. Idempotent: the audit
 * trail itself is the record of what was already reported
 * (`resource = user:<id>`), so a restart writes nothing new. Returns the number
 * of rows written.
 *
 * Sized for an instance a bot filled with sign-ups. The "already reported"
 * lookup filters on the event type alone and diffs in memory: one bind
 * parameter per account would pass Postgres' 65,535 limit and throw on every
 * boot. The writes go one at a time — each takes the audit chain's lock — and
 * yield between batches of REPORT_BATCH_SIZE so live requests' audit writes and
 * the event loop are not held up behind a long backlog.
 */
export async function reportUnknownOriginUsers(): Promise<number> {
  const flagged = await findUnknownOriginUsers();
  if (flagged.length === 0) return 0;

  const already = await db
    .select({ resource: auditLog.resource })
    .from(auditLog)
    .where(eq(auditLog.eventType, UNKNOWN_ORIGIN_EVENT));
  const reported = new Set(already.map((r) => r.resource));
  const pending = flagged.filter((u) => !reported.has(`user:${u.id}`));

  let written = 0;
  for (let i = 0; i < pending.length; i += REPORT_BATCH_SIZE) {
    if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    for (const user of pending.slice(i, i + REPORT_BATCH_SIZE)) {
      const entry: AuditLogEntry = {
        actorType: "system",
        actorId: "system",
        eventType: UNKNOWN_ORIGIN_EVENT,
        resource: `user:${user.id}`,
        detail: {
          user: { id: user.id, name: user.name },
          role: user.role,
          accountCreatedAt: user.createdAt.toISOString(),
        },
        outcome: "success",
      };
      try {
        await appendAuditLog(entry);
        written++;
      } catch (err) {
        recordAuditFailure(err, entry);
      }
    }
  }
  return written;
}
