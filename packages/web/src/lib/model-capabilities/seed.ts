import { db } from "@/db";
import { models } from "@/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";

type BuiltinRow = {
  provider: string;
  modelId: string;
  displayName: string;
  vision: boolean;
  longContext: boolean;
  tools: boolean;
};

function collectBuiltinRows(): BuiltinRow[] {
  const out: BuiltinRow[] = [];
  for (const provider of ["anthropic", "openai", "google"] as const) {
    for (const m of getModelCatalogForProvider(provider)) {
      out.push({
        provider,
        modelId: m.id,
        displayName: m.name,
        vision: m.vision,
        longContext: m.contextWindow >= 200_000,
        tools: true,
      });
    }
  }
  for (const m of TOOL_CAPABLE_OLLAMA_CLOUD_MODELS) {
    out.push({
      provider: "ollama-cloud",
      modelId: m.id,
      displayName: m.id,
      vision: m.vision,
      longContext: m.contextWindow >= 200_000,
      tools: true,
    });
  }
  return out;
}

export async function seedBuiltinModels(): Promise<void> {
  const builtins = collectBuiltinRows();
  if (builtins.length === 0) return;

  const values = builtins.map((row) => ({ ...row, source: "builtin" }));

  // Single bulk upsert. Manual rows (source = 'manual') keep their fields;
  // builtin rows always get the latest catalog values. Avoids the N+1
  // round-trip pattern that previously made boot wait on ~50 sequential
  // INSERT … ON CONFLICT statements.
  await db
    .insert(models)
    .values(values)
    .onConflictDoUpdate({
      target: [models.provider, models.modelId],
      set: {
        displayName: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.displayName} ELSE EXCLUDED.display_name END`,
        vision: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.vision} ELSE EXCLUDED.vision END`,
        longContext: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.longContext} ELSE EXCLUDED.long_context END`,
        tools: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.tools} ELSE EXCLUDED.tools END`,
        updatedAt: sql`now()`,
      },
    });

  // Drop stale builtin rows in a single statement. Uses the (provider,
  // modelId) composite — `notInArray` over a tuple would be cleaner, but
  // drizzle doesn't yet support that, so we filter per provider to keep the
  // statement count bounded by the small set of providers (3-4) rather than
  // the number of models.
  const buildersByProvider = new Map<string, string[]>();
  for (const b of builtins) {
    const ids = buildersByProvider.get(b.provider);
    if (ids) ids.push(b.modelId);
    else buildersByProvider.set(b.provider, [b.modelId]);
  }
  for (const [provider, modelIds] of buildersByProvider) {
    await db
      .delete(models)
      .where(
        and(
          eq(models.source, "builtin"),
          eq(models.provider, provider),
          notInArray(models.modelId, modelIds)
        )
      );
  }
}
