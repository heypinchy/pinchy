import { db } from "@/db";
import { models } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";

type BuiltinRow = {
  provider: string;
  modelId: string;
  displayName: string;
  vision: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
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
        documents: m.documents,
        audio: m.audio,
        video: m.video,
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
      documents: m.documents,
      audio: m.audio,
      video: m.video,
      longContext: m.contextWindow >= 200_000,
      tools: true,
    });
  }
  return out;
}

export async function seedBuiltinModels(): Promise<void> {
  const builtins = collectBuiltinRows();

  for (const row of builtins) {
    await db
      .insert(models)
      .values({ ...row, source: "builtin" })
      .onConflictDoUpdate({
        target: [models.provider, models.modelId],
        set: {
          displayName: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.displayName} ELSE EXCLUDED.display_name END`,
          vision: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.vision} ELSE EXCLUDED.vision END`,
          documents: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.documents} ELSE EXCLUDED.documents END`,
          audio: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.audio} ELSE EXCLUDED.audio END`,
          video: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.video} ELSE EXCLUDED.video END`,
          longContext: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.longContext} ELSE EXCLUDED.long_context END`,
          tools: sql`CASE WHEN ${models.source} = 'manual' THEN ${models.tools} ELSE EXCLUDED.tools END`,
          updatedAt: sql`now()`,
        },
      });
  }

  const keepKeys = new Set(builtins.map((b) => `${b.provider}/${b.modelId}`));
  const allBuiltin = await db.select().from(models).where(eq(models.source, "builtin"));
  for (const row of allBuiltin) {
    if (!keepKeys.has(`${row.provider}/${row.modelId}`)) {
      await db
        .delete(models)
        .where(
          and(
            eq(models.provider, row.provider),
            eq(models.modelId, row.modelId),
            eq(models.source, "builtin")
          )
        );
    }
  }
}
