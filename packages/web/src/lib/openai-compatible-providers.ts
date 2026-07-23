// Data-access layer for the generic "OpenAI-compatible" provider type (#894).
//
// The `apiKey` column is AES-256-GCM ciphertext (encrypt() from
// @/lib/encryption) — it is written encrypted and only ever decrypted where a
// caller genuinely needs the plaintext (the secrets bundle in Task 7, and the
// last-4 `keyHint` shown in the admin UI). The list path never returns the
// decrypted key.

import { db } from "@/db";
import { openaiCompatibleProviders } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import { deriveProviderSlug } from "@/lib/openai-compatible-slug";
import type { UpsertOpenAiCompatibleProviderInput } from "@/lib/schemas/openai-compatible-provider";
import { eq } from "drizzle-orm";

/** A provider row safe to expose to the admin UI — no decrypted key, only the last-4 hint. */
export interface OpenAiCompatibleProviderListItem {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  models: OpenClawModelDefinition[];
  /** Last 4 characters of the decrypted API key, for at-a-glance identification. */
  keyHint: string;
  createdAt: Date;
  updatedAt: Date;
}

function toListItem(
  row: typeof openaiCompatibleProviders.$inferSelect
): OpenAiCompatibleProviderListItem {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    models: row.models,
    keyHint: decrypt(row.apiKey).slice(-4),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List every provider WITHOUT the decrypted key. Each row carries a `keyHint`
 * (last 4 chars of the decrypted key) for display; the full key never leaves
 * this module through this path.
 */
export async function listOpenAiCompatibleProviders(): Promise<OpenAiCompatibleProviderListItem[]> {
  const rows = await db.select().from(openaiCompatibleProviders);
  return rows.map(toListItem);
}

/**
 * The plaintext API key for one provider, resolved by slug. Returns `null` when
 * no such provider exists. Used by the secrets bundle (Task 7).
 */
export async function getDecryptedApiKey(slug: string): Promise<string | null> {
  const row = await db.query.openaiCompatibleProviders.findFirst({
    where: eq(openaiCompatibleProviders.slug, slug),
  });
  if (!row) return null;
  return decrypt(row.apiKey);
}

/**
 * Create (no `id`) or update (`id` present) a provider.
 *
 * On create the slug is derived once from `displayName` (collision- and
 * reserved-name-safe) and the API key is required. On update the slug is
 * immutable and the API key is optional — omitting it keeps the existing
 * ciphertext untouched so the client never round-trips a secret it can't read.
 */
export async function createOrUpdateProvider(
  input: UpsertOpenAiCompatibleProviderInput
): Promise<OpenAiCompatibleProviderListItem> {
  if (input.id) {
    return updateProvider(input.id, input);
  }
  return createProvider(input);
}

async function createProvider(
  input: UpsertOpenAiCompatibleProviderInput
): Promise<OpenAiCompatibleProviderListItem> {
  if (!input.apiKey) {
    throw new Error("An API key is required to create an OpenAI-compatible provider.");
  }

  // The in-memory Set dedup below is best-effort: two concurrent creates of the
  // same displayName can both read the same snapshot and derive the same slug.
  // The `slug` UNIQUE constraint on the table is the real backstop — the losing
  // insert fails loudly on the constraint rather than silently duplicating.
  const existing = await db
    .select({ slug: openaiCompatibleProviders.slug })
    .from(openaiCompatibleProviders);
  const slug = deriveProviderSlug(input.displayName, new Set(existing.map((r) => r.slug)));

  const [row] = await db
    .insert(openaiCompatibleProviders)
    .values({
      slug,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      apiKey: encrypt(input.apiKey),
      models: input.models,
    })
    .returning();

  return toListItem(row!);
}

async function updateProvider(
  id: string,
  input: UpsertOpenAiCompatibleProviderInput
): Promise<OpenAiCompatibleProviderListItem> {
  // Slug is immutable — never recomputed on update.
  const set: Partial<typeof openaiCompatibleProviders.$inferInsert> = {
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    models: input.models,
    updatedAt: new Date(),
  };
  // Re-encrypt only when a new key is supplied; otherwise keep the stored one.
  if (input.apiKey) {
    set.apiKey = encrypt(input.apiKey);
  }

  const [row] = await db
    .update(openaiCompatibleProviders)
    .set(set)
    .where(eq(openaiCompatibleProviders.id, id))
    .returning();

  if (!row) {
    throw new Error(`OpenAI-compatible provider not found: ${id}`);
  }

  return toListItem(row);
}

/**
 * Delete a provider by id. Returns the deleted row's `{ id, slug, displayName }`
 * (needed for audit + agent migration in later tasks), or `null` if no row
 * matched.
 */
export async function deleteProviderById(
  id: string
): Promise<{ id: string; slug: string; displayName: string } | null> {
  const [row] = await db
    .delete(openaiCompatibleProviders)
    .where(eq(openaiCompatibleProviders.id, id))
    .returning({
      id: openaiCompatibleProviders.id,
      slug: openaiCompatibleProviders.slug,
      displayName: openaiCompatibleProviders.displayName,
    });

  return row ?? null;
}
