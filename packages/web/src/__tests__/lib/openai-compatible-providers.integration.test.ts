import { db } from "@/db";
import { openaiCompatibleProviders } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import {
  createOrUpdateProvider,
  deleteProviderById,
  getProviderSnapshotById,
  listOpenAiCompatibleProviders,
  ProviderChangedError,
  ProviderNotFoundError,
  listOpenAiCompatibleProvidersForAdmin,
  listProvidersWithApiKeys,
} from "@/lib/openai-compatible-providers";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const MODEL: OpenClawModelDefinition = {
  id: "swisscom-large",
  name: "Swisscom Large",
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: false,
  vision: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

beforeEach(async () => {
  await db.delete(openaiCompatibleProviders);
});

describe("createOrUpdateProvider — create", () => {
  it("derives the slug from displayName and stores the api key as ciphertext", async () => {
    const created = await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-secret-plaintext-value",
      },
      [MODEL]
    );

    expect(created.slug).toBe("swisscom-ai");

    const raw = await db.query.openaiCompatibleProviders.findFirst({
      where: eq(openaiCompatibleProviders.slug, "swisscom-ai"),
    });
    expect(raw).toBeTruthy();
    // Stored column must be ciphertext, never the plaintext key.
    expect(raw!.apiKey).not.toBe("sk-secret-plaintext-value");
    expect(decrypt(raw!.apiKey)).toBe("sk-secret-plaintext-value");
    expect(raw!.models).toEqual([MODEL]);
  });

  it("suffixes the slug on collision", async () => {
    await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-one",
      },
      [MODEL]
    );
    const second = await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-two",
      },
      [MODEL]
    );

    expect(second.slug).toBe("swisscom-ai-2");
  });

  it("throws a clear error when apiKey is missing on create", async () => {
    await expect(
      createOrUpdateProvider(
        {
          displayName: "No Key Provider",
          baseUrl: "https://api.example/v1",
        },
        [MODEL]
      )
    ).rejects.toThrow(/api key/i);
  });
});

describe("listOpenAiCompatibleProviders (hot-path, key-free)", () => {
  it("returns identity + models with NO keyHint and NO key material", async () => {
    await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-secret-abcd",
      },
      [MODEL]
    );

    const rows = await listOpenAiCompatibleProviders();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.slug).toBe("swisscom-ai");
    expect(row.displayName).toBe("Swisscom AI");
    expect(row.baseUrl).toBe("https://api.swisscom.example/v1");
    expect(row.models).toEqual([MODEL]);

    // This accessor deliberately performs no decrypt: no keyHint, no ciphertext,
    // and certainly not the plaintext key.
    expect(row).not.toHaveProperty("keyHint");
    expect(row).not.toHaveProperty("apiKey");
    expect(JSON.stringify(row)).not.toContain("sk-secret-abcd");
  });
});

describe("listOpenAiCompatibleProvidersForAdmin", () => {
  it("exposes only the last-4 keyHint and never the decrypted key", async () => {
    await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-secret-abcd",
      },
      [MODEL]
    );

    const rows = await listOpenAiCompatibleProvidersForAdmin();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.keyHint).toBe("abcd");
    expect(row.slug).toBe("swisscom-ai");
    expect(row.models).toEqual([MODEL]);

    // The full/decrypted key must not appear anywhere in the serialized row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("sk-secret-abcd");
    expect(row).not.toHaveProperty("apiKey");
  });
});

/** Read one provider's decrypted key back via the real secrets-bundle path. */
async function readStoredKey(slug: string): Promise<string | undefined> {
  return (await listProvidersWithApiKeys()).find((r) => r.slug === slug)?.apiKey;
}

describe("listProvidersWithApiKeys", () => {
  it("returns identity, base URL, models and the real decrypted key + version for every row, from one read", async () => {
    await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-swiss-real",
      },
      [MODEL]
    );
    await createOrUpdateProvider(
      {
        displayName: "Acme LLM",
        baseUrl: "https://acme.example/v1",
        apiKey: "sk-acme-real",
      },
      [MODEL]
    );

    const rows = await listProvidersWithApiKeys();
    // Order-independent: each key comes back beside the base URL of its own row.
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          slug: "swisscom-ai",
          displayName: "Swisscom AI",
          baseUrl: "https://api.swisscom.example/v1",
          models: [MODEL],
          apiKey: "sk-swiss-real",
          keyVersion: expect.any(String),
        },
        {
          slug: "acme-llm",
          displayName: "Acme LLM",
          baseUrl: "https://acme.example/v1",
          models: [MODEL],
          apiKey: "sk-acme-real",
          keyVersion: expect.any(String),
        },
      ])
    );
    expect(rows).toHaveLength(2);

    // Shape is exactly what config emission needs — no keyHint, no ciphertext.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "apiKey",
        "baseUrl",
        "displayName",
        "keyVersion",
        "models",
        "slug",
      ]);
      expect(row.keyVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(row.keyVersion).not.toContain(row.apiKey);
      expect(row).not.toHaveProperty("keyHint");
    }
  });

  it("returns an empty array when no providers exist", async () => {
    expect(await listProvidersWithApiKeys()).toEqual([]);
  });

  // The keyVersion names the provider's secrets-bundle slot, so it must move
  // exactly when a key is (re-)entered — and only then. A rename or a model
  // refresh must not churn the SecretRef; a new key (even the same value typed
  // again, e.g. alongside a new base URL) must.
  it("keeps keyVersion across an update without a key, and changes it whenever a key is entered", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Swisscom AI", baseUrl: "https://api.swisscom.example/v1", apiKey: "sk-k" },
      [MODEL]
    );
    const version = async () =>
      (await listProvidersWithApiKeys()).find((r) => r.slug === "swisscom-ai")!.keyVersion;
    const v1 = await version();

    await createOrUpdateProvider(
      {
        id: created.id,
        displayName: "Swisscom Renamed",
        baseUrl: "https://api.swisscom.example/v1",
      },
      [MODEL],
      await getProviderSnapshotById(created.id)
    );
    expect(await version()).toBe(v1);

    await createOrUpdateProvider(
      {
        id: created.id,
        displayName: "Swisscom Renamed",
        baseUrl: "https://moved.swisscom.example/v1",
        apiKey: "sk-k",
      },
      [MODEL],
      await getProviderSnapshotById(created.id)
    );
    expect(await version()).not.toBe(v1);
  });
});

describe("createOrUpdateProvider — update", () => {
  it("keeps the slug immutable and preserves the key when apiKey is omitted", async () => {
    const created = await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-original-key",
      },
      [MODEL]
    );

    const updated = await createOrUpdateProvider(
      {
        id: created.id,
        displayName: "Swisscom AI Renamed",
        baseUrl: "https://api.swisscom.example/v2",
      },
      [MODEL],
      await getProviderSnapshotById(created.id)
    );

    expect(updated.slug).toBe("swisscom-ai");
    expect(updated.displayName).toBe("Swisscom AI Renamed");
    expect(updated.baseUrl).toBe("https://api.swisscom.example/v2");
    // Key untouched when omitted.
    expect(await readStoredKey("swisscom-ai")).toBe("sk-original-key");

    // Now update WITH a new key.
    await createOrUpdateProvider(
      {
        id: created.id,
        displayName: "Swisscom AI Renamed",
        baseUrl: "https://api.swisscom.example/v2",
        apiKey: "sk-rotated-key",
      },
      [MODEL],
      await getProviderSnapshotById(created.id)
    );
    expect(await readStoredKey("swisscom-ai")).toBe("sk-rotated-key");
  });

  // Typed, so the route can answer a row deleted mid-save with the same 404 as
  // an unknown id instead of treating it as a persist failure (500).
  it("throws a ProviderNotFoundError when the id does not exist", async () => {
    const update = createOrUpdateProvider(
      {
        id: "00000000-0000-0000-0000-000000000000",
        displayName: "Ghost",
        baseUrl: "https://api.example/v1",
      },
      [MODEL],
      { baseUrl: "https://api.example/v1", encryptedApiKey: "irrelevant" }
    );
    await expect(update).rejects.toThrow(/not found/i);
    await expect(update).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it("refuses an update that does not say which stored state it was checked against", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Swisscom AI", baseUrl: "https://api.swisscom.example/v1", apiKey: "sk-k" },
      [MODEL]
    );
    await expect(
      createOrUpdateProvider(
        { id: created.id, displayName: "Swisscom AI", baseUrl: "https://api.swisscom.example/v1" },
        [MODEL]
      )
    ).rejects.toThrow(/checked/i);
  });

  // The write is a compare-and-swap on (base_url, api_key): the route checked
  // the destination against one stored state, then spent up to ~10s on
  // discovery against a host the caller may control. If the key was
  // re-entered meanwhile, a keyless save landing now would pair the caller's
  // URL with that new key.
  it("refuses a keyless update when the stored key changed since the check, and leaves the row alone", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Swisscom AI", baseUrl: "https://evil.example/v1", apiKey: "sk-attacker" },
      [MODEL]
    );
    const checked = await getProviderSnapshotById(created.id);

    // Meanwhile the real admin moves it back and re-enters the real key.
    await createOrUpdateProvider(
      {
        id: created.id,
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-real",
      },
      [MODEL],
      checked
    );

    await expect(
      createOrUpdateProvider(
        { id: created.id, displayName: "Swisscom AI", baseUrl: "https://evil.example/v1" },
        [MODEL],
        checked
      )
    ).rejects.toBeInstanceOf(ProviderChangedError);

    const [row] = await db
      .select()
      .from(openaiCompatibleProviders)
      .where(eq(openaiCompatibleProviders.id, created.id));
    expect(row.baseUrl).toBe("https://api.swisscom.example/v1");
    expect(decrypt(row.apiKey)).toBe("sk-real");
  });

  it("refuses an update carrying a key when the base URL changed since the check", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Swisscom AI", baseUrl: "https://api.swisscom.example/v1", apiKey: "sk-k" },
      [MODEL]
    );
    const checked = await getProviderSnapshotById(created.id);
    await db
      .update(openaiCompatibleProviders)
      .set({ baseUrl: "https://moved.swisscom.example/v1" })
      .where(eq(openaiCompatibleProviders.id, created.id));

    await expect(
      createOrUpdateProvider(
        {
          id: created.id,
          displayName: "Swisscom AI",
          baseUrl: "https://api.swisscom.example/v1",
          apiKey: "sk-new",
        },
        [MODEL],
        checked
      )
    ).rejects.toBeInstanceOf(ProviderChangedError);
    expect(await readStoredKey("swisscom-ai")).toBe("sk-k");
  });
});

describe("getProviderSnapshotById", () => {
  it("returns identity, base URL and key ciphertext from one row, and undefined for an unknown id", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Swisscom AI", baseUrl: "https://api.swisscom.example/v1", apiKey: "sk-key" },
      [MODEL]
    );
    const snapshot = await getProviderSnapshotById(created.id);
    expect(snapshot).toEqual({
      id: created.id,
      slug: "swisscom-ai",
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      encryptedApiKey: expect.any(String),
    });
    // Ciphertext, never the key itself.
    expect(snapshot!.encryptedApiKey).not.toContain("sk-key");
    expect(decrypt(snapshot!.encryptedApiKey)).toBe("sk-key");
    expect(await getProviderSnapshotById("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });
});

describe("deleteProviderById", () => {
  it("returns the deleted row identity and removes it; null when nothing deleted", async () => {
    const created = await createOrUpdateProvider(
      {
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        apiKey: "sk-key",
      },
      [MODEL]
    );

    const deleted = await deleteProviderById(created.id);
    expect(deleted).toEqual({
      id: created.id,
      slug: "swisscom-ai",
      displayName: "Swisscom AI",
    });

    const rows = await listOpenAiCompatibleProviders();
    expect(rows).toHaveLength(0);

    expect(await deleteProviderById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
