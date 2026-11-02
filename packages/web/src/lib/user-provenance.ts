import { and, asc, eq, inArray, ne, notExists, sql } from "drizzle-orm";
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
 *   - or the claimer of an invite of type `invite`. A claimed `reset` invite is
 *     issued for an account that already exists, so it explains nothing.
 *
 * Known limits. Nothing is acted on automatically — an admin reviews the
 * list — so these mostly over-report:
 *
 *   - a setup admin who was later demoted is flagged, because the earliest
 *     remaining admin is then someone else. The one way to under-report sits
 *     here too: if that earliest remaining admin is a self-registered account
 *     an admin promoted, it passes as the setup admin;
 *   - an invite deleted after it was claimed (only possible by calling
 *     `DELETE /api/users/invites/:id` directly — the UI lists pending invites
 *     only) or removed with its inviter (`invites.created_by` cascades on a
 *     hard user delete, which Pinchy itself never does);
 *   - a claim that crashed between creating the account and marking the
 *     invite claimed.
 */
export interface UnknownOriginUser {
  id: string;
  name: string;
  role: string;
  banned: boolean;
  createdAt: Date;
}

export const UNKNOWN_ORIGIN_EVENT = "user.unknown_origin_detected" as const;

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

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      banned: users.banned,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(setupAdminId ? and(noClaimedInvite, ne(users.id, setupAdminId)) : noClaimedInvite)
    .orderBy(asc(users.createdAt), asc(users.id));

  return rows.map((r) => ({ ...r, banned: r.banned ?? false }));
}

/**
 * Write one `user.unknown_origin_detected` audit row for every unknown-origin
 * account that has none yet. Runs at boot (lib/boot-inits.ts), so the upgrade
 * that closes the sign-up endpoint is also the moment those accounts show up
 * in the audit trail. Idempotent: the audit trail itself is the record of what
 * was already reported (`resource = user:<id>`), so a restart writes nothing
 * new. Returns the number of rows written.
 */
export async function reportUnknownOriginUsers(): Promise<number> {
  const flagged = await findUnknownOriginUsers();
  if (flagged.length === 0) return 0;

  const resources = flagged.map((u) => `user:${u.id}`);
  const already = await db
    .select({ resource: auditLog.resource })
    .from(auditLog)
    .where(
      and(eq(auditLog.eventType, UNKNOWN_ORIGIN_EVENT), inArray(auditLog.resource, resources))
    );
  const reported = new Set(already.map((r) => r.resource));

  let written = 0;
  for (const user of flagged) {
    const resource = `user:${user.id}`;
    if (reported.has(resource)) continue;
    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "system",
      eventType: UNKNOWN_ORIGIN_EVENT,
      resource,
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
  return written;
}
