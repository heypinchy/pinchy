/**
 * Index-time OCR for scanned PDFs: which vision model reads them, and whose
 * key pays for it.
 *
 * ── Why this reuses the plugin's vision call ──────────────────────────────
 * Pinchy already reads scanned PDFs with a vision model — `pinchy-files` does
 * it every time an agent opens one. Building a second reader for the index
 * would mean two engines producing two different texts for the same page, and
 * a citation that points at a chunk the agent cannot find when it opens the
 * file. So the provider protocol is imported from the plugin rather than
 * reimplemented; `pdf-scan-rule.ts` there explains why the shared modules
 * physically live on that side of the boundary.
 *
 * ── What this means for data flow, plainly ────────────────────────────────
 * With OCR on, every scanned document in the corpus is sent to the configured
 * provider once, at index time — including documents nobody ever asks about.
 * That is a larger claim than "only the question and the retrieved snippets
 * leave the building", and the docs say so. `PINCHY_KB_OCR=off` turns it off,
 * at the price of scans staying unsearchable.
 */
import {
  describePageImage,
  type VisionApiConfig,
} from "../../../../plugins/pinchy-files/pdf-vision-api";
import { resolveDefaultVisionModelChain } from "@/lib/openclaw-config/default-media-models";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";

import type { PdfOcrOptions } from "./pdf-extract";

/**
 * Provider name (as it appears in a model id) → the setting holding its key.
 *
 * An explicit map, not an index into `PROVIDERS`: the provider name reaches
 * `resolveApiKey` parsed out of a model id, so it is derived data, and a bare
 * lookup would answer for `constructor` and `__proto__` too. URL-authenticated
 * providers are absent because they have no key to hand out.
 */
const PROVIDER_KEY_SETTINGS = new Map<string, string>(
  (Object.entries(PROVIDERS) as [ProviderName, (typeof PROVIDERS)[ProviderName]][])
    .filter(([, config]) => config.authType === "api-key")
    .map(([name, config]) => [name, config.settingsKey])
);

export interface ResolveKbOcrDeps {
  /** Test seam. Production uses the plugin's shared vision call. */
  describeImage?: typeof describePageImage;
}

/**
 * The OCR half of the extractor, plus the model that will do the reading.
 *
 * The model is exposed because the audit row names it: "these documents were
 * sent to a provider" is only a useful record if it says which one.
 */
export type KbOcrSetup = PdfOcrOptions & { model: string };

/** Whether the operator has turned index-time OCR off. */
function disabledByOperator(): boolean {
  const value = process.env.PINCHY_KB_OCR?.trim().toLowerCase();
  return value === "off" || value === "false" || value === "0";
}

/**
 * Builds the OCR half of the ingest's PDF extractor, or null when index-time
 * OCR cannot or should not run.
 *
 * Null is a normal answer, not a failure: a text-only stack, an air-gapped
 * install whose only models are local (the vision chain deliberately excludes
 * `ollama-local`), or an operator who turned it off. In every one of those the
 * ingest proceeds and a scan indexes as an empty page — visible as an
 * unsearchable document rather than as a failed one.
 */
export async function resolveKbOcr(deps: ResolveKbOcrDeps = {}): Promise<KbOcrSetup | null> {
  if (disabledByOperator()) return null;

  const model = (await resolveDefaultVisionModelChain())[0];
  if (!model) return null;

  const resolveApiKey = async (provider: string): Promise<string | null> => {
    const settingsKey = PROVIDER_KEY_SETTINGS.get(provider);
    if (!settingsKey) return null;
    return getSetting(settingsKey);
  };

  // Resolved once, before the run rather than per page: a chain entry whose
  // key has since been removed would otherwise spend a render on every scanned
  // page of the corpus before failing each one.
  const provider = model.split("/")[0];
  if (PROVIDER_KEY_SETTINGS.has(provider) && !(await resolveApiKey(provider))) return null;

  const config: VisionApiConfig = { model, resolveApiKey };
  const describeImage = deps.describeImage ?? describePageImage;

  return {
    model,
    ocrPage: async (pageImage) => {
      const result = await describeImage(pageImage.toString("base64"), config);
      // null, not "": a failed provider call must stay distinguishable from a
      // page that genuinely says nothing.
      return result?.text ?? null;
    },
  };
}
