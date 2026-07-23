import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { discoverSchema } from "@/lib/schemas/openai-compatible-provider";
import {
  validateOpenAiCompatibleProvider,
  fetchOpenAiCompatibleModels,
} from "@/lib/openai-compatible-discovery";

// Connect-and-discover probe for a generic OpenAI-compatible endpoint (#894).
// audit-exempt: read-only discovery probe, no state change — it neither
// persists anything nor regenerates config, and it NEVER logs or returns the
// API key. On a valid connection it returns the discovered model list; when the
// endpoint exposes no `/models`, it flags `manualEntry` so the UI falls back to
// manual model-id entry. On failure it conveys the ValidationResult variant
// (invalid_key / provider_error / network_error) as `{ ok: false, error }` so
// the UI can render it inline.
export const POST = withAdmin(async (request) => {
  const parsed = await parseRequestBody(discoverSchema, request);
  if ("error" in parsed) return parsed.error;
  const { baseUrl, apiKey } = parsed.data;

  const validation = await validateOpenAiCompatibleProvider(baseUrl, apiKey);
  if (!validation.valid) {
    return NextResponse.json({ ok: false, error: validation.error });
  }

  const models = await fetchOpenAiCompatibleModels(baseUrl, apiKey);
  if (models.length === 0) {
    // The endpoint has no `/models` (or returned nothing usable) — let the UI
    // collect model ids by hand.
    return NextResponse.json({ ok: true, models: [], manualEntry: true });
  }

  return NextResponse.json({ ok: true, models });
});
