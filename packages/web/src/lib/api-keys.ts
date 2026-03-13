import { createHash, randomBytes } from "crypto";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, and, isNull, or, gt } from "drizzle-orm";

const KEY_PREFIX = "pnch_";
const KEY_LENGTH = 32; // bytes → 64 hex chars

/** Generate a new API key. Returns the plaintext key (show once) and the DB record. */
export async function createApiKey(opts: {
  name: string;
  userId: string;
  scopes?: string[];
  expiresAt?: Date;
}): Promise<{ key: string; id: string; keyPrefix: string }> {
  const raw = randomBytes(KEY_LENGTH).toString("hex");
  const key = `${KEY_PREFIX}${raw}`;
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 12) + "...";

  const [record] = await db
    .insert(apiKeys)
    .values({
      name: opts.name,
      keyHash,
      keyPrefix,
      userId: opts.userId,
      scopes: opts.scopes ?? ["read"],
      expiresAt: opts.expiresAt ?? null,
    })
    .returning({ id: apiKeys.id });

  return { key, id: record!.id, keyPrefix };
}

/** Validate an API key. Returns user info if valid, null if not. */
export async function validateApiKey(key: string): Promise<{
  id: string;
  userId: string;
  scopes: string[];
  name: string;
} | null> {
  const keyHash = hashKey(key);

  const [record] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        eq(apiKeys.revoked, false),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))
      )
    )
    .limit(1);

  if (!record) return null;

  // Update last used timestamp (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, record.id))
    .catch(() => {});

  return {
    id: record.id,
    userId: record.userId,
    scopes: record.scopes,
    name: record.name,
  };
}

/** List API keys for a user (never returns the actual key). */
export async function listApiKeys(userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revoked: apiKeys.revoked,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));
}

/** Revoke an API key. */
export async function revokeApiKey(id: string, userId: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));

  return (result.rowCount ?? 0) > 0;
}

/** Delete an API key permanently. */
export async function deleteApiKey(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));

  return (result.rowCount ?? 0) > 0;
}

/** SHA-256 hash of a key. */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
