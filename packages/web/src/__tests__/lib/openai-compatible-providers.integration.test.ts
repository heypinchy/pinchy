import { db } from "@/db";
import { openaiCompatibleProviders } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import {
  createOrUpdateProvider,
  deleteProviderById,
  listOpenAiCompatibleProviders,
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
    const created = await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-secret-plaintext-value",
      models: [MODEL],
    });

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
    await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-one",
      models: [MODEL],
    });
    const second = await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-two",
      models: [MODEL],
    });

    expect(second.slug).toBe("swisscom-ai-2");
  });

  it("throws a clear error when apiKey is missing on create", async () => {
    await expect(
      createOrUpdateProvider({
        displayName: "No Key Provider",
        baseUrl: "https://api.example/v1",
        models: [MODEL],
      })
    ).rejects.toThrow(/api key/i);
  });
});

describe("listOpenAiCompatibleProviders (hot-path, key-free)", () => {
  it("returns identity + models with NO keyHint and NO key material", async () => {
    await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-secret-abcd",
      models: [MODEL],
    });

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
    await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-secret-abcd",
      models: [MODEL],
    });

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
  it("returns exactly { slug, apiKey } with real decrypted keys for every row", async () => {
    await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-swiss-real",
      models: [MODEL],
    });
    await createOrUpdateProvider({
      displayName: "Acme LLM",
      baseUrl: "https://acme.example/v1",
      apiKey: "sk-acme-real",
      models: [MODEL],
    });

    const rows = await listProvidersWithApiKeys();
    // Order-independent: assert the set of decrypted { slug, apiKey } pairs.
    expect(rows).toEqual(
      expect.arrayContaining([
        { slug: "swisscom-ai", apiKey: "sk-swiss-real" },
        { slug: "acme-llm", apiKey: "sk-acme-real" },
      ])
    );
    expect(rows).toHaveLength(2);

    // Shape is EXACTLY slug + apiKey — no keyHint, no ciphertext, no extra fields.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["apiKey", "slug"]);
      expect(row).not.toHaveProperty("keyHint");
      expect(row).not.toHaveProperty("models");
    }
  });

  it("returns an empty array when no providers exist", async () => {
    expect(await listProvidersWithApiKeys()).toEqual([]);
  });
});

describe("createOrUpdateProvider — update", () => {
  it("keeps the slug immutable and preserves the key when apiKey is omitted", async () => {
    const created = await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-original-key",
      models: [MODEL],
    });

    const updated = await createOrUpdateProvider({
      id: created.id,
      displayName: "Swisscom AI Renamed",
      baseUrl: "https://api.swisscom.example/v2",
      models: [MODEL],
    });

    expect(updated.slug).toBe("swisscom-ai");
    expect(updated.displayName).toBe("Swisscom AI Renamed");
    expect(updated.baseUrl).toBe("https://api.swisscom.example/v2");
    // Key untouched when omitted.
    expect(await readStoredKey("swisscom-ai")).toBe("sk-original-key");

    // Now update WITH a new key.
    await createOrUpdateProvider({
      id: created.id,
      displayName: "Swisscom AI Renamed",
      baseUrl: "https://api.swisscom.example/v2",
      apiKey: "sk-rotated-key",
      models: [MODEL],
    });
    expect(await readStoredKey("swisscom-ai")).toBe("sk-rotated-key");
  });

  it("throws a clear error when the id does not exist", async () => {
    await expect(
      createOrUpdateProvider({
        id: "00000000-0000-0000-0000-000000000000",
        displayName: "Ghost",
        baseUrl: "https://api.example/v1",
        models: [MODEL],
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("deleteProviderById", () => {
  it("returns the deleted row identity and removes it; null when nothing deleted", async () => {
    const created = await createOrUpdateProvider({
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "sk-key",
      models: [MODEL],
    });

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
