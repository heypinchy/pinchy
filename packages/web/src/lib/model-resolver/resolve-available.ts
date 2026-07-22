import { fetchProviderModels, getDefaultModel } from "@/lib/provider-models";
import {
  ensureModelCapabilityCacheLoaded,
  modelCapabilityStatus,
} from "@/lib/model-capabilities/cache";
import { resolveModelForTemplate } from "./index";
import { TemplateCapabilityUnavailableError } from "./types";
import type { ResolverInput, ResolverResult } from "./types";

// The pick-was-retired path can only offer the generic providers docs; the
// ollama-local resolver keeps its own, more specific "install a model" link.
const CAPABILITY_DOCS_URL = "https://docs.heypinchy.com/guides/llm-providers";

/**
 * Is `model` present in the current provider catalog?
 *
 * `fetchProviderModels` returns the LIVE `/v1/models` intersection when the
 * fetch succeeds, and the static `FALLBACK_MODELS` list when it fails. So this
 * check heals against live data when we have it and degrades to best-effort
 * (keep the pick, since the static fallback still lists it) when we do not —
 * exactly the guard the self-heal path uses: only act on a confirmed signal.
 */
async function isInProviderCatalog(model: string): Promise<boolean> {
  const providers = await fetchProviderModels();
  return providers.some((p) => p.models.some((m) => m.id === model));
}

/**
 * Live-availability wrapper around `resolveModelForTemplate` (#883).
 *
 * The per-provider tier resolvers hardcode their picks (`providers/*.ts`), and a
 * provider can retire a pinned model between Pinchy releases — so a freshly
 * created agent could land on a model the provider no longer serves, which then
 * fails every run (the #881 self-heal only rescues an agent AFTER it is already
 * pinned to a dead model). This wraps the pure resolver: if its pick is no
 * longer in the provider catalog, substitute the provider's LIVE default while
 * preserving the template's required capabilities — or fail loud rather than
 * silently hand back a model that cannot do the job.
 *
 * Same-provider only, matching #881: the substitute is always the SAME
 * provider's default, never a cross-provider switch.
 */
export async function resolveAvailableModelForTemplate(
  input: ResolverInput
): Promise<ResolverResult> {
  const resolved = await resolveModelForTemplate(input);

  // ollama-local already resolves against the models the user has actually
  // installed (`resolveOllamaLocal`), so it can never offer a retired model —
  // and it has no cloud catalog to check against. Skip the live gate there.
  if (input.provider === "ollama-local") return resolved;

  if (await isInProviderCatalog(resolved.model)) return resolved;

  // The hardcoded pick is no longer served by the provider (retired upstream).
  // Substitute the provider's live default, which `getDefaultModel` resolves
  // against the same catalog — so it is live by construction.
  const substitute = await getDefaultModel(input.provider);
  const required = input.hint.capabilities ?? [];

  if (substitute === resolved.model) {
    // The catalog says the pick is gone yet the default resolves back to it —
    // an inconsistent catalog state. Fail loud instead of pinning a model the
    // live check just rejected. Checked BEFORE the capability gate so we never
    // interrogate capabilities of the very model the live check rejected.
    throw new TemplateCapabilityUnavailableError(required, input.provider, CAPABILITY_DOCS_URL);
  }

  // Capability gate. The cache is seeded from the curated builtin catalog, so a
  // live default newer than this release has no row — `unknown`, NOT
  // `unsupported`. A missing row is not proof of a missing capability: throwing
  // on it would be a false 422 in exactly the retire-and-replace case this
  // wrapper handles. So we only fail loud on a capability we KNOW is absent, and
  // flag any unverified requirement in the reason for the audit trail.
  let capabilitiesUnverified = false;
  if (required.length > 0) {
    await ensureModelCapabilityCacheLoaded();
    const missing: typeof required = [];
    for (const cap of required) {
      const status = modelCapabilityStatus(substitute, cap);
      if (status === "unsupported") missing.push(cap);
      else if (status === "unknown") capabilitiesUnverified = true;
    }
    if (missing.length > 0) {
      // Loud, not silent: a vision/tools template must not degrade to a model
      // that is KNOWN to lack the requirement. Surfaced as the existing 422 path.
      throw new TemplateCapabilityUnavailableError(missing, input.provider, CAPABILITY_DOCS_URL);
    }
  }

  const reasonSuffix = capabilitiesUnverified
    ? ` (capabilities unverified: ${substitute} not in capability catalog)`
    : "";
  return {
    model: substitute,
    reason: `${input.provider}: template pick ${resolved.model} retired → live default ${substitute}${reasonSuffix}`,
    fallbackUsed: true,
  };
}
