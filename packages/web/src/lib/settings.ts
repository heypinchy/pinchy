import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
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

export async function getAllSettings() {
  return db.select().from(settings);
}
