import { it, expect, beforeEach } from "vitest";
import { seedBuiltinModels } from "@/lib/model-capabilities/seed";
import { db } from "@/db";
import { models } from "@/db/schema";
import { eq, and } from "drizzle-orm";

beforeEach(async () => {
  await db.delete(models);
});

it("inserts a row for every built-in model on first run", async () => {
  await seedBuiltinModels();
  const rows = await db.select().from(models);
  // Anthropic (3) + OpenAI (3) + Google (3) + ollama-cloud (18) = 27.
  // The floor was 30 when ollama-cloud carried ~33 models; the 2026-07-15
  // retirement wave cut that to 18. A floor near the real total is just a
  // snapshot that breaks on every retirement — this guards "the seed inserted
  // every provider's models, not only the first provider's", so it only has to
  // sit above any single provider's count.
  expect(rows.length).toBeGreaterThanOrEqual(20);
  expect(rows.every((r) => r.source === "builtin")).toBe(true);
});

it("is idempotent — running twice produces the same rows", async () => {
  await seedBuiltinModels();
  const after1 = await db.select().from(models);
  await seedBuiltinModels();
  const after2 = await db.select().from(models);
  expect(after2.length).toBe(after1.length);
});

it("does not clobber rows with source=manual", async () => {
  await db.insert(models).values({
    provider: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Custom Name",
    vision: false,
    longContext: false,
    tools: false,
    source: "manual",
  });
  await seedBuiltinModels();
  const [row] = await db
    .select()
    .from(models)
    .where(and(eq(models.provider, "anthropic"), eq(models.modelId, "claude-opus-4-7")));
  expect(row.displayName).toBe("Custom Name");
  expect(row.source).toBe("manual");
});

it("removes rows with source=builtin no longer in the registry", async () => {
  await db.insert(models).values({
    provider: "anthropic",
    modelId: "removed-model",
    displayName: "Removed",
    vision: true,
    longContext: false,
    tools: false,
    source: "builtin",
  });
  await seedBuiltinModels();
  const rows = await db.select().from(models).where(eq(models.modelId, "removed-model"));
  expect(rows).toHaveLength(0);
});
