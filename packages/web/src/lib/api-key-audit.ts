import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * Resolve the display name of the user who issued the calling API key, for
 * the audit `issuer` snapshot (design D2 — the key is logged as an
 * independent machine actor; the issuing admin is separate delegation
 * metadata inside `detail`, never merged into the actor fields).
 *
 * `ApiKeyContext` only carries `issuerUserId` (better-auth's `referenceId`),
 * not a name, so the route resolves it once per request. MUST NOT throw: a
 * missing user (deleted after the key was issued) or a DB hiccup both
 * degrade to an empty name — the audit write (and agent creation) must never
 * fail because of this lookup.
 */
export async function resolveIssuer(issuerUserId: string): Promise<{ id: string; name: string }> {
  try {
    const rows = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, issuerUserId));
    return { id: issuerUserId, name: rows[0]?.name ?? "" };
  } catch {
    return { id: issuerUserId, name: "" };
  }
}
