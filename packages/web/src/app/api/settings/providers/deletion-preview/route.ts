import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { formatValidationError } from "@/lib/api-validation";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { builtInModelPrefix, previewProviderDeletion } from "@/lib/provider-deletion";
import {
  deletionPreviewQuerySchema,
  type DeletionPreviewResponse,
} from "@/lib/schemas/provider-deletion";

// Preflight for the provider-removal dialog (#949): which provider and model
// every affected agent WOULD be moved onto, and which agents those are.
//
// It exists so the client never re-derives the migration target. The ordering
// policy lives in `buildRemainingCandidates()`; a copy in provider-key-form.tsx
// would drift, and the dialog would then confidently name the wrong provider —
// strictly worse than the vague sentence it replaces. Both DELETE routes and
// this preview call that one helper (see previewProviderDeletion).
//
// Admin-only, mirroring the DELETE routes it previews: it discloses configured
// providers and agent names.
export const GET = withAdmin(async (request) => {
  // audit-exempt: read-only preview, no state change.
  const parsed = deletionPreviewQuerySchema.safeParse({
    provider: request.nextUrl.searchParams.get("provider") ?? undefined,
  });
  if (!parsed.success) return formatValidationError(parsed.error);
  const { provider } = parsed.data;

  // A built-in is identified by name, a custom instance by slug. Resolving the
  // prefix here is what makes the preview count the same agents the DELETE
  // migrates — `ollama-local` notably namespaces its models as `ollama/`.
  const builtIn = PROVIDERS[provider as ProviderName];
  let deletedPrefix: string;
  if (builtIn) {
    deletedPrefix = builtInModelPrefix(provider);
  } else {
    const custom = (await listOpenAiCompatibleProviders()).find((row) => row.slug === provider);
    if (!custom) {
      return NextResponse.json({ error: "Provider not found." }, { status: 404 });
    }
    deletedPrefix = `${custom.slug}/`;
  }

  const { target, affectedAgents } = await previewProviderDeletion({
    providerName: provider,
    deletedPrefix,
  });

  const body: DeletionPreviewResponse = {
    targetProvider: target?.name ?? null,
    targetProviderLabel: target?.label ?? null,
    targetModel: target?.defaultModel ?? null,
    affectedAgents,
  };
  return NextResponse.json(body);
});
