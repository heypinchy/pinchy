import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { openaiCompatibleProviders } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("openai_compatible_providers table", () => {
  beforeEach(async () => {
    await db.delete(openaiCompatibleProviders);
  });

  it("stores and reads back an instance", async () => {
    await db.insert(openaiCompatibleProviders).values({
      slug: "swisscom-ai",
      displayName: "Swisscom AI Platform",
      baseUrl: "https://api.swisscom.example/v1",
      apiKey: "encrypted-blob",
      models: [
        {
          id: "mistral-large-2512",
          name: "Mistral Large 3",
          contextWindow: 262144,
          maxTokens: 8192,
          reasoning: false,
          vision: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const row = await db.query.openaiCompatibleProviders.findFirst({
      where: eq(openaiCompatibleProviders.slug, "swisscom-ai"),
    });
    expect(row?.displayName).toBe("Swisscom AI Platform");
    expect(row?.models).toHaveLength(1);
  });

  it("rejects a duplicate slug", async () => {
    const base = {
      slug: "dup",
      displayName: "A",
      baseUrl: "https://x/v1",
      apiKey: "k",
      models: [],
    };
    await db.insert(openaiCompatibleProviders).values(base);
    await expect(db.insert(openaiCompatibleProviders).values(base)).rejects.toThrow();
  });
});
