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

/**
 * A provider row WITHOUT any key material — safe for the many internal callers
 * that only need identity + models (model list, config emission, provider count,
 * agent migration, model resolution). Deliberately carries no `keyHint`: those
 * callers never read it, and computing it forces an AES-GCM decrypt per row on
 * hot paths (every `regenerateOpenClawConfig` / `fetchProviderModels`).
 */
export interface OpenAiCompatibleProvider {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  models: OpenClawModelDefinition[];
  createdAt: Date;
  updatedAt: Date;
}

/** A provider row for the admin UI: adds the last-4 `keyHint` (one decrypt/row). */
export interface OpenAiCompatibleProviderListItem extends OpenAiCompatibleProvider {
  /** Last 4 characters of the decrypted API key, for at-a-glance identification. */
  keyHint: string;
}

/**
 * Column set for the key-free reads. Selecting explicit columns (not `*`) also
 * keeps the ciphertext out of the result entirely — nothing to accidentally log.
 *
 * Built lazily inside a function (not a module-level const) so importing this
 * module never dereferences the Drizzle schema at load time — several suites
 * mock `@/db/schema`, and a top-level `openaiCompatibleProviders.id` would throw
 * on import in those files.
 */
function keyFreeColumns() {
  return {
    id: openaiCompatibleProviders.id,
    slug: openaiCompatibleProviders.slug,
    displayName: openaiCompatibleProviders.displayName,
    baseUrl: openaiCompatibleProviders.baseUrl,
    models: openaiCompatibleProviders.models,
    createdAt: openaiCompatibleProviders.createdAt,
    updatedAt: openaiCompatibleProviders.updatedAt,
  };
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
 * List every provider WITHOUT decrypting any key (no `keyHint`). This is the
 * hot-path accessor used by config emission, the model list, the provider
 * count, agent migration, and model resolution — none of which read the key.
 * For the admin UI's keyHint, use {@link listOpenAiCompatibleProvidersForAdmin}.
 */
export async function listOpenAiCompatibleProviders(): Promise<OpenAiCompatibleProvider[]> {
  return db.select(keyFreeColumns()).from(openaiCompatibleProviders);
}

/**
 * List every provider WITH a `keyHint` (last 4 chars of the decrypted key) for
 * the admin settings view. This is the ONLY read path that decrypts — kept off
 * the hot callers above. The full key never leaves this module through here.
 */
export async function listOpenAiCompatibleProvidersForAdmin(): Promise<
  OpenAiCompatibleProviderListItem[]
> {
  const rows = await db.select().from(openaiCompatibleProviders);
  return rows.map(toListItem);
}

/**
 * Every provider's `{ slug, apiKey }` with the key decrypted, in one query and
 * one decrypt per row. Purpose-built for the secrets bundle (`collectProviderSecrets`)
 * so it never pays the `listOpenAiCompatibleProviders` keyHint-decrypt tax nor a
 * per-slug round trip (the old 1+N / 2N-decrypt path). The decrypted key never
 * leaves the secrets pipeline — do not use this for anything exposed to the client.
 */
export async function listProvidersWithApiKeys(): Promise<{ slug: string; apiKey: string }[]> {
  const rows = await db.select().from(openaiCompatibleProviders);
  return rows.map((r) => ({ slug: r.slug, apiKey: decrypt(r.apiKey) }));
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
