import { afterAll, it, expect } from "vitest";
import { db } from "@/db";
import { models } from "@/db/schema";
import { eq } from "drizzle-orm";

it("inserts and retrieves a model row with all capability fields", async () => {
  await db.insert(models).values({
    provider: "anthropic",
    modelId: "claude-test",
    displayName: "Claude Test",
    vision: true,
    documents: true,
    audio: false,
    video: false,
    longContext: true,
    tools: true,
    source: "builtin",
  });
  const [row] = await db.select().from(models).where(eq(models.modelId, "claude-test"));
  expect(row.vision).toBe(true);
  expect(row.documents).toBe(true);
  expect(row.source).toBe("builtin");
});

afterAll(async () => {
  await db.delete(models).where(eq(models.modelId, "claude-test"));
});
