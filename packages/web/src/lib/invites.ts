import { randomBytes, createHash } from "crypto";
import { db } from "@/db";
import { invites } from "@/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";

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
}: {
  email?: string;
  role: string;
  type?: "invite" | "reset";
  createdBy: string;
}) {
  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [invite] = await db
    .insert(invites)
    .values({ tokenHash, email, role, type, createdBy, expiresAt })
    .returning();

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

export async function claimInvite(tokenHash: string, userId: string) {
  const [updated] = await db
    .update(invites)
    .set({ claimedAt: new Date(), claimedByUserId: userId })
    .where(eq(invites.tokenHash, tokenHash))
    .returning();

  return updated;
}
