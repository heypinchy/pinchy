import { requiredCapabilityForFile } from "@/lib/attachment-capability";
import { isBlocked } from "@/lib/model-resolver/blocklist";
import type { ModelCapability } from "@/lib/model-resolver/types";

/**
 * Per-turn image-model fallback decision.
 *
 * OpenClaw's `agent` RPC (which Pinchy uses, because it carries `extraSystemPrompt`
 * for per-user context and `provider`/`model` for capability resolution — params
 * `chat.send` rejects under `additionalProperties: false`) throws
 * `UnsupportedAttachmentError` when an image is sent to a text-only model, instead
 * of offloading it to a vision model the way the `chat.send` path does.
 *
 * So Pinchy routes an image-bearing turn on a text-only agent to a vision-capable
 * fallback model for that ONE turn (via the per-request provider/model override the
 * agent RPC already accepts — see #324), WITHOUT changing the agent's stored model.
 * The override is ephemeral: the next text turn resolves back to the agent's model.
 *
 * This pure function decides which of the three cases applies; the call site wires
 * it into the chat options, audit log, and UI indicator.
 */
export type TurnModelDecision =
  { kind: "agent-model" } | { kind: "fallback"; model: string } | { kind: "blocked" };

export function decideTurnModel(params: {
  /** True when any attachment on this turn requires the vision capability. */
  turnNeedsVision: boolean;
  /** True when the agent's own configured model can accept image input. */
  agentModelSupportsVision: boolean;
  /** Best available vision-capable model (`provider/model`), or null if none configured. */
  visionFallbackModel: string | null;
}): TurnModelDecision {
  if (!params.turnNeedsVision || params.agentModelSupportsVision) {
    return { kind: "agent-model" };
  }
  if (params.visionFallbackModel) {
    return { kind: "fallback", model: params.visionFallbackModel };
  }
  return { kind: "blocked" };
}

/** A vision-capable model available in the catalog, used to pick a fallback. */
export type VisionCandidate = {
  /** `provider/model` identifier. */
  id: string;
  provider: string;
  tools: boolean;
};

/**
 * Pick the vision model to run an image-bearing turn on when the agent's own
 * model is text-only.
 *
 * Robustness priority: prefer a vision model from the SAME provider as the agent's
 * model. Switching providers mid-conversation is where cross-provider history
 * breakage lives (reasoning/thinking signatures, tool-call formats); staying on
 * the agent's provider sidesteps it. When the agent uses tools, prefer a
 * same-provider model that also has the tools capability so the turn doesn't lose
 * tool access. Only when no same-provider vision model exists do we reach for the
 * system-wide default (or any remaining candidate) — a cross-provider swap is a
 * better outcome than blocking the user outright.
 *
 * Before any of that, every candidate (and the global default) is filtered
 * through the SAME tools blocklist the model picker and agent-model validation
 * already enforce. Without this, a tool-using agent's image turn could be routed
 * to a model the rest of Pinchy forbids — exactly what happened to text-only
 * agents on an ollama-cloud stack: the seeder marks every cloud model
 * `tools: true`, so `gemini-3-flash-preview` (vision + tools, but blocklisted
 * because `-preview` drops `thought_signature` and the provider rejects the
 * tool payload with a 400 — pinchy#344/#338) was picked first and crashed the
 * turn. The blocklist only forbids it WHEN tools are required, so a chat-only
 * agent can still use a preview model for pure image description.
 *
 * `candidates` are passed in caller-defined preference order.
 */
export function resolveVisionFallbackModel(params: {
  agentModel: string;
  agentUsesTools: boolean;
  candidates: VisionCandidate[];
  globalDefault: string | null;
}): string | null {
  const requiredCaps: ModelCapability[] = params.agentUsesTools ? ["vision", "tools"] : ["vision"];
  const usable = params.candidates.filter((c) => !isBlocked(c.id, requiredCaps));

  const slashIdx = params.agentModel.indexOf("/");
  const agentProvider = slashIdx > 0 ? params.agentModel.slice(0, slashIdx) : "";

  const sameProvider = usable.filter((c) => c.provider === agentProvider);
  if (sameProvider.length > 0) {
    if (params.agentUsesTools) {
      return (sameProvider.find((c) => c.tools) ?? sameProvider[0]).id;
    }
    return sameProvider[0].id;
  }

  if (params.globalDefault && !isBlocked(params.globalDefault, requiredCaps)) {
    return params.globalDefault;
  }
  if (usable.length > 0) return usable[0].id;
  return null;
}

/**
 * Orchestrates the per-turn decision from the turn's attachments and the agent,
 * pulling capability data through injected dependencies so the logic stays pure
 * and unit-testable. The call site (the WebSocket chat router) supplies the real
 * I/O adapters (capability cache, catalog query, persisted imageModel).
 *
 * Skips all catalog/config I/O when the turn doesn't need a model swap (no image,
 * or the agent's own model is already vision-capable).
 */
export async function resolveImageTurnModel(params: {
  agentModel: string;
  agentUsesTools: boolean;
  attachmentMimeTypes: string[];
  deps: {
    modelSupportsVision: (model: string) => boolean;
    listVisionCandidates: () => Promise<VisionCandidate[]>;
    getGlobalImageModel: () => string | null;
  };
}): Promise<TurnModelDecision> {
  const turnNeedsVision = params.attachmentMimeTypes.some(
    (mime) => requiredCapabilityForFile(mime) === "vision"
  );
  const agentModelSupportsVision = params.deps.modelSupportsVision(params.agentModel);

  if (!turnNeedsVision || agentModelSupportsVision) {
    return decideTurnModel({
      turnNeedsVision,
      agentModelSupportsVision,
      visionFallbackModel: null,
    });
  }

  const candidates = await params.deps.listVisionCandidates();
  const visionFallbackModel = resolveVisionFallbackModel({
    agentModel: params.agentModel,
    agentUsesTools: params.agentUsesTools,
    candidates,
    globalDefault: params.deps.getGlobalImageModel(),
  });
  return decideTurnModel({ turnNeedsVision, agentModelSupportsVision, visionFallbackModel });
}
