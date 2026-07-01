// Diagnostics agent-config collector.
//
// Captures the agent's *configuration at export time* so a support reader can
// tell whether a failure came from model choice or from drifted
// instructions/permissions (issue #642). It reads from the SAME sources the
// Agent Settings UI uses — the DB agent row (model, allowed tools, template,
// personality preset) plus the on-disk workspace instruction files — so the
// snapshot matches what the operator sees.
//
// Secret hygiene: the raw system prompt / instructions are NEVER embedded, only
// a SHA-256 hash per file. That makes drift visible (AGENTS.md notes "agent
// instructions can diverge" from the shipped template) without leaking custom
// prompt content into support archives. Model ids, tool names, and template/
// preset names carry no secrets; provider API keys and SecretRefs never enter
// this snapshot.

import { createHash } from "node:crypto";

import { getTemplate } from "@/lib/agent-templates/registry";
import { resolveDefaultImageModel } from "@/lib/openclaw-config/default-media-models";
import { getPersonalityPreset } from "@/lib/personality-presets";
import { ALLOWED_FILES, readWorkspaceFile } from "@/lib/workspace";

/** The subset of the agent row this collector needs (structurally satisfied by
 * the row returned from `getAgentWithAccess`). */
export interface AgentConfigInput {
  id: string;
  name: string;
  model: string;
  allowedTools: string[];
  templateId: string | null;
  personalityPresetId: string | null;
}

export interface AgentConfigSnapshot {
  agent: { id: string; name: string };
  /** Full configured model id, e.g. "openai/gpt-5.4-mini". */
  model: string;
  /** Provider inferred from the model prefix, or "unknown" when unprefixed. */
  provider: string;
  /** Resolved default image/vision model in effect (vision offload), if any. */
  imageModel?: string;
  template: { id: string; name: string } | null;
  personalityPreset: { id: string; name: string } | null;
  /** Per-agent allow-list — the value the Permissions UI reads/writes. Not the
   * union `computeAllowedTools()` emits to OpenClaw. */
  allowedTools: string[];
  /** SHA-256 hash per instruction file (e.g. SOUL.md, AGENTS.md), never the raw
   * prompt. Same "sha256:"+hex shape as the bundle's sessionKeyHash. */
  instructionsHash: Record<string, string>;
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

/** Snapshot an id-referenced entity as an { id, name } pair (audit convention),
 * or null when the id is unset or the registry has no match for it. */
function resolveRef(
  id: string | null,
  lookup: (id: string) => { name: string } | undefined
): { id: string; name: string } | null {
  if (!id) return null;
  const found = lookup(id);
  return found ? { id, name: found.name } : null;
}

export async function collectAgentConfig(agent: AgentConfigInput): Promise<AgentConfigSnapshot> {
  const provider = agent.model.includes("/") ? agent.model.split("/")[0] : "unknown";

  const template = resolveRef(agent.templateId, getTemplate);
  const personalityPreset = resolveRef(agent.personalityPresetId, getPersonalityPreset);

  const instructionsHash: Record<string, string> = Object.fromEntries(
    ALLOWED_FILES.map((file) => [file, sha256(readWorkspaceFile(agent.id, file))])
  );

  // Best-effort: no per-agent image model exists, so we snapshot the org-wide
  // default vision model that actually handles image offload. A settings/DB
  // hiccup must not fail the whole export.
  let imageModel: string | undefined;
  try {
    imageModel = (await resolveDefaultImageModel()) ?? undefined;
  } catch {
    imageModel = undefined;
  }

  return {
    agent: { id: agent.id, name: agent.name },
    model: agent.model,
    provider,
    ...(imageModel ? { imageModel } : {}),
    template,
    personalityPreset,
    allowedTools: agent.allowedTools,
    instructionsHash,
  };
}
