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
  // Anthropic (3) + OpenAI (3) + Google (3) + ollama-cloud (~33) = ~42
  expect(rows.length).toBeGreaterThanOrEqual(30);
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
