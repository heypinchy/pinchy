import { randomBytes, createHash } from "crypto";
import { db } from "@/db";
import { invites, inviteGroups, users } from "@/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";

type InviteRow = typeof invites.$inferSelect;
type UserRow = typeof users.$inferSelect;

/**
 * Resolves a raw invite token into the flow it drives, shared by the
 * `GET /api/invite/[token]` loader and the `POST /api/invite/claim` handler so
 * the two can never disagree on what a token means.
 *
 * - Unknown / expired / claimed token → `{ ok: false, status: 410 }`.
 * - Reset token whose target user no longer exists → `{ ok: false, status: 404 }`.
 * - Otherwise the discriminated `type` carries the data each caller needs: a
 *   reset resolution guarantees a non-null `user`.
 */
export type InviteFlowResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; type: "invite"; invite: InviteRow }
  | { ok: true; type: "reset"; invite: InviteRow; user: UserRow };

export async function resolveInviteFlow(token: string): Promise<InviteFlowResolution> {
  const invite = await validateInviteToken(token);
  if (!invite) {
    return { ok: false, status: 410, error: "Invalid or expired invite link" };
  }

  if (invite.type === "reset") {
    const user = invite.email
      ? await db.query.users.findFirst({ where: eq(users.email, invite.email) })
      : null;
    if (!user) {
      return { ok: false, status: 404, error: "User not found" };
    }
    return { ok: true, type: "reset", invite, user };
  }

  return { ok: true, type: "invite", invite };
}

const TOKEN_BYTES = 32;
const EXPIRY_DAYS = 7;

export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export async function createInvite({
  email,
  role,
  type = "invite",
  createdBy,
  groupIds,
}: {
  email?: string;
  role: string;
  type?: "invite" | "reset";
  createdBy: string;
  groupIds?: string[];
}) {
  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const invite = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(invites)
      .values({ tokenHash, email, role, type, createdBy, expiresAt })
      .returning();

    if (groupIds && groupIds.length > 0) {
      await tx
        .insert(inviteGroups)
        .values(groupIds.map((groupId) => ({ inviteId: created.id, groupId })));
    }

    return created;
  });

  return { ...invite, token };
}

export async function validateInviteToken(token: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const invite = await db.query.invites.findFirst({
    where: and(
      eq(invites.tokenHash, tokenHash),
      isNull(invites.claimedAt),
      gt(invites.expiresAt, new Date())
    ),
  });

  return invite ?? null;
}

/**
 * Mark the invite identified by `tokenHash` as claimed by `userId`.
 *
 * `executor` lets the caller pass a Drizzle transaction handle so this
 * write participates in a wrapping transaction (used by the password-reset
 * flow to keep accounts/sessions/invite updates atomic). When omitted,
 * the global `db` is used.
 */
export async function claimInvite(
  tokenHash: string,
  userId: string,
  executor: Pick<typeof db, "update"> = db
) {
  const [updated] = await executor
    .update(invites)
    .set({ claimedAt: new Date(), claimedByUserId: userId })
    .where(and(eq(invites.tokenHash, tokenHash), isNull(invites.claimedAt)))
    .returning();

  return updated ?? null;
}

export async function getInviteGroupIds(inviteId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: inviteGroups.groupId })
    .from(inviteGroups)
    .where(eq(inviteGroups.inviteId, inviteId));
  return rows.map((r) => r.groupId);
}
