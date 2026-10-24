import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt, decrypt } from "@/lib/encryption";

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.query.settings.findFirst({
    where: eq(settings.key, key),
  });
  if (!row) return null;

  return row.encrypted ? decrypt(row.value) : row.value;
}

export async function setSetting(key: string, value: string, encrypted = false) {
  const storedValue = encrypted ? encrypt(value) : value;
  await db
    .insert(settings)
    .values({ key, value: storedValue, encrypted })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: storedValue, encrypted },
    });
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

export async function getAllSettings() {
  return db.select().from(settings);
}

/**
 * Fetch every setting whose key starts with `prefix` in a single query and
 * return them as a Map (key → decrypted value). Replaces the N+1 pattern of
 * looping `getSetting(key)` per agent — the settings table is small enough
 * that one round-trip beats N (#261). Mirrors `getSetting`'s decrypt rule.
 */
export async function getSettingsByPrefix(prefix: string): Promise<Map<string, string>> {
  const rows = await getAllSettings();
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.key.startsWith(prefix)) {
      out.set(r.key, r.encrypted ? decrypt(r.value) : r.value);
    }
  }
  return out;
}

/**
 * Fetch exactly the named settings, decrypted, as a Map. For a caller on a hot
 * path that knows its keys: `getSettingsByPrefix` reads the whole table (every
 * provider key and bot token included) and filters in JS.
 */
export async function getSettingsByKeys(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  for (const r of rows) out.set(r.key, r.encrypted ? decrypt(r.value) : r.value);
  return out;
}
