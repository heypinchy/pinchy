import { readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isDeepStrictEqual } from "util";
import { writeSecretsFile, secretRef, type SecretsBundle } from "@/lib/openclaw-secrets";
import { PROVIDERS, type ProviderName, resolveProviderBaseUrl } from "@/lib/providers";
import { getDefaultModel, fetchOllamaLocalModelsFromUrl } from "@/lib/provider-models";
import { eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  agentConnectionPermissions,
  integrationConnections,
  channelLinks,
} from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import type { AgentPluginConfig } from "@/db/schema";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS, OLLAMA_CLOUD_COST } from "@/lib/ollama-cloud-models";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";
import {
  getOpenClawWorkspacePath,
  getAgentBootstrapSizes,
  writeWorkspaceSkill,
} from "@/lib/workspace";
import { getSkillBody, isKnownSkill } from "@/lib/skills";
import { resolveBootstrapCaps } from "./bootstrap-caps";
import { CONFIG_PATH } from "./paths";
import { configsAreEquivalentUpToOpenClawMetadata } from "./normalize";
import { readExistingConfig, pushConfigInBackground } from "./write";
import {
  buildSecretsBundle,
  collectPluginSecrets,
  collectProviderSecrets,
  readGatewayTokenFromConfig,
} from "./secrets-bundle";
import { writeAgentAuthProfiles, type AuthProfilesProvider } from "./agent-auth-profiles";
// Docker host aliases live in @/lib/openclaw-local-url so they can be shared
// with `validateProviderUrl`'s save-time allowlist check (#296).
import { DOCKER_HOST_ALIASES } from "@/lib/openclaw-local-url";
import { validateBuiltConfig } from "./validate-built-config";
import {
  BUILTIN_PROVIDER_DEFAULT_BASE_URLS,
  BUILTIN_PROVIDER_PATH_SUFFIX,
  BUILTIN_PROVIDER_BASE_URL_ENV_VARS,
  BUILTIN_PROVIDER_API,
} from "./provider-defaults";
import { resolveDefaultPdfModel, resolveDefaultImageModel } from "./default-media-models";
import { deepMerge } from "./deep-merge";
import { buildGatewayBlock } from "./gateway";

/**
 * Public docs URL configuration for the bundled `pinchy-docs` plugin.
 *
 * `DOCS_PUBLIC_BASE_URL_SETTING_KEY` is the operator-facing settings row that
 * overrides the default. Three-state semantics:
 *   - `null` (unset)       → fall back to {@link DEFAULT_DOCS_PUBLIC_BASE_URL}
 *   - `""` (empty string)  → opt-out, plugin emits path-only output for
 *                            air-gapped forks without published docs
 *   - any other string     → use as the public base URL
 *
 * Keep this as the single source of truth — tests import these constants
 * rather than the literal so a domain move only touches one line.
 */
export const DOCS_PUBLIC_BASE_URL_SETTING_KEY = "docs_public_base_url";
export const DEFAULT_DOCS_PUBLIC_BASE_URL = "https://docs.heypinchy.com";

/**
 * Rewrites the user-supplied Ollama URL so OpenClaw's `isLocalBaseUrl` check
 * passes. Container-host aliases (see `DOCKER_HOST_ALIASES`) get normalized to
 * `ollama.local` — which clears the check via the rock-stable `.local` rule and
 * decouples us from OpenClaw's host-alias allowlist churn (see the
 * `DOCKER_HOST_ALIASES` doc for the full rationale — this is load-bearing, not a
 * version workaround). Private IPv4, `*.local`, `localhost`, etc. are stable
 * allowlist entries and pass through unchanged.
 *
 * Also appends `/v1` so pi-ai's openai-completions provider hits Ollama's
 * OpenAI-compatible endpoint at `/v1/chat/completions` (pi-ai appends
 * `/chat/completions` to the configured baseUrl). Idempotent: a URL that
 * already ends in `/v1` is left untouched.
 *
 * Exported for unit testing — the rewrite logic is pure and benefits from
 * direct test coverage independent of the larger config-emission pipeline.
 */
export function rewriteOllamaHostForOpenClaw(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/$/, "");
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (DOCKER_HOST_ALIASES.has(host)) {
      parsed.hostname = "ollama.local";
    }
    // Ollama's OpenAI-compatible API lives at /v1. pi-ai's openai-completions
    // provider appends /chat/completions to the baseUrl, so we include /v1
    // here so requests land at /v1/chat/completions (not /chat/completions).
    const withV1 = parsed.toString().replace(/\/$/, "");
    return withV1.endsWith("/v1") ? withV1 : `${withV1}/v1`;
  } catch {
    // Not a parseable URL — return as-is (validateProviderUrl already rejected garbage).
    return trimmed;
  }
}

/**
 * Picks the per-model contextWindow we ship to OpenClaw. Real values come
 * from Ollama's `/api/show` response (see fetchOllamaLocalModelsFromUrl);
 * older Ollama versions omit `model_info` entirely, so we fall back to a
 * safe 32k that the most common Ollama models (qwen2.5:7b, llama3:8b, ...)
 * comfortably support.
 */
const OLLAMA_LOCAL_DEFAULT_CONTEXT_WINDOW = 32_768;

/**
 * pi-ai's openai-completions provider doesn't have a sensible default for
 * max_tokens, so we cap it ourselves. 8k is enough for any tool-calling
 * exchange we've seen in production while staying safely under every
 * supported model's context window — including small-context models like
 * `phi3:mini` (which has a 4k context but isn't tool-capable, so it never
 * reaches OpenClaw anyway).
 */
const OLLAMA_LOCAL_MAX_TOKENS_CAP = 8_192;

export async function regenerateOpenClawConfig() {
  // `readExistingConfig` distinguishes two recoverable failure modes:
  //   - ENOENT / parse error → returns {} (cold start; we build the first config from scratch).
  //   - Persistent EACCES → throws (file exists but unreadable; race with OC's
  //     SIGUSR1-driven 0600/0666 chmod loop). We MUST NOT proceed with an
  //     empty `existing` in that case: every `...existing.<field>` spread
  //     collapses, OC enrichments (meta, gateway.controlUi.*, non-pinchy
  //     plugins.entries, channels.telegram OC fields) get stripped, and the
  //     resulting thin payload triggers the inotify cascade documented in #314.
  //   On EACCES, wait one chmod-loop tick and try once more; if still
  //   unreadable, skip the regenerate entirely — the next API-triggered
  //   regenerate (or boot-inits) will heal once 0666 is restored.
  let existing: Record<string, unknown>;
  try {
    existing = readExistingConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EACCES") throw err;
    await new Promise((r) => setTimeout(r, 300));
    try {
      existing = readExistingConfig();
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException)?.code !== "EACCES") throw err2;
      console.error(
        "[openclaw-config] regenerate skipped: openclaw.json is persistently " +
          "unreadable (EACCES) after one chmod-loop retry. This is the " +
          "OC-restart race documented in #314 — the next regenerate (or " +
          "boot-inits) will heal once 0666 is restored. No write performed."
      );
      // Silent return: callers (POST /api/agents, POST /api/settings/*) treat this
      // as success because the file on disk is intentionally left untouched and
      // still represents the previous good state. This assumes another regenerate
      // *will* run later — true for change-on-change flows (subsequent setting
      // edits, channel pair/unpair, agent CRUD), and boot-inits re-regenerate
      // unconditionally. One-shot actions with no follow-up mutation are the
      // only blind spot; targeted writes (updateTelegramChannelConfig)
      // still throw under EACCES so those callers surface 5xx and the user
      // can retry.
      return;
    }
  }

  // If readExistingConfig returned empty (ENOENT / parse failure, NOT EACCES —
  // EACCES is handled above) it may be a transient cold-start hit. 300ms
  // covers one chmod-loop tick worst case for parse-during-write races.
  if (Object.keys(existing).length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      existing = readExistingConfig();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EACCES") throw err;
      // File appeared during the wait and is now locked — same recovery path
      // as the first-read EACCES branch above.
      console.error(
        "[openclaw-config] regenerate skipped: openclaw.json became " +
          "unreadable (EACCES) during the cold-start retry. See #314."
      );
      return;
    }
  }

  // Build the gateway block (see buildGatewayBlock for the mode/bind/auth and
  // Control-UI rationale). The token is resolved here because it's reused later
  // when writing secrets.json and the plugin gatewayToken bootstrap creds.
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const gatewayTokenValue = await readGatewayTokenFromConfig(existing);
  if (!gatewayTokenValue) {
    // DB unavailable and no existing config — log and continue. Token will be
    // provisioned on the next regenerateOpenClawConfig() pass once the DB is ready.
    console.warn(
      "[openclaw-config] No gateway token found. " +
        "Writing empty token — OpenClaw auth will reject requests until the token is provisioned."
    );
  }
  const gateway = buildGatewayBlock(existingGateway, gatewayTokenValue);

  // Read all agents from DB
  const allAgents = await db.select().from(agents);
  // Live (non-tombstoned) agents. Soft-deleted agents must never be emitted as
  // addressable agents, tool configs, or integration grants in the runtime
  // config — they'd point at a deleted workspace and keep their permissions.
  // Prefer `liveAgents` everywhere an agent is emitted; `allAgents` is only for
  // cases that legitimately need tombstones (e.g. id-stability bookkeeping).
  const liveAgents = allAgents.filter((a) => !a.deletedAt);

  // Pattern A from CLAUDE.md "Secrets Handling": secret pair for each LLM
  // provider with a configured apiKey. Helper returns a fresh mutable map;
  // ollama-cloud is spliced into providerSecrets at the model-providers call site.
  const { providers: providerSecrets } = await collectProviderSecrets();

  // Keep agents.defaults minimal. OpenClaw enriches agents.defaults with
  // heartbeat, models, contextPruning, compaction at runtime; if Pinchy were to
  // OVERWRITE those, a cold-start race (Pinchy writes before OpenClaw enriches →
  // OpenClaw enriches → diff → hot-reload → polling dies, openclaw#47458) could
  // recur. We avoid that by (a) only writing the few fields below and (b) the
  // `deepMerge(existingAgents, …)` at the config-assembly step, which preserves
  // every OpenClaw-enriched sibling on each regenerate.
  const pinchyDefaults: Record<string, unknown> = {
    // Disable OpenClaw's native pre-compaction memory flush. The flush hard-codes
    // the built-in `read`/`write` tools (OpenClaw's MEMORY_FLUSH_ALLOWED_TOOL_NAMES),
    // which Pinchy denies via `group:fs` for every agent (see tool-registry.ts).
    // It therefore runs with zero tools, flails through "tool not found" attempts,
    // returns NO_REPLY, and consumes the user's inbound turn — on production it
    // silently dropped a Telegram receipt image. Pinchy already owns memory
    // persistence through the audited, path-scoped `pinchy_write` (the agent
    // journals to memory/ on its own; see memory-prompt.ts), so the native flush
    // is a redundant, ungoverned duplicate.
    //
    // OpenClaw reads this flag ONLY from agents.defaults.compaction.memoryFlush —
    // there is no per-agent override (buildMemoryFlushPlan in OpenClaw). Writing it
    // here is reload-safe, verified against the production OpenClaw binary (2026.5.28)
    // on two fronts: (1) the very first write turns compaction from absent→present,
    // but OpenClaw's reload classifier (config-reload-plan) matches the changed path
    // `agents.defaults.compaction.*` to the broad `agents` rule → kind "none" → noop,
    // NOT a gateway restart, so there is no #47458-style polling-death cascade;
    // (2) on every later regenerate, the `deepMerge(existingAgents, …)` below
    // preserves whatever compaction siblings OpenClaw stamped, so the config stays
    // byte-identical → zero changed paths → no reload at all. The field is also
    // schema-valid (OpenClaw's zod schema declares memoryFlush.enabled as boolean).
    compaction: { memoryFlush: { enabled: false } },
  };
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  if (defaultProvider && PROVIDERS[defaultProvider]) {
    pinchyDefaults.model = { primary: await getDefaultModel(defaultProvider) };
  }

  // Auto-set pdfModel to the best vision-capable model available.
  // The built-in `pdf` tool registers only when this resolves — without it,
  // agents on text-only models (e.g. deepseek-v4-flash) get no PDF capability.
  const pdfModel = await resolveDefaultPdfModel();
  if (pdfModel) {
    pinchyDefaults.pdfModel = { primary: pdfModel };
  }

  // Auto-set imageModel for the built-in `image` tool. Without this,
  // OpenClaw falls through to provider image defaults and may pick a
  // vision-flagged model whose runtime API rejects images (e.g.
  // devstral-small-2 on ollama-cloud, #416). The explicit pin removes that
  // failure mode and lets ops override via settings if needed.
  const imageModel = await resolveDefaultImageModel();
  if (imageModel) {
    pinchyDefaults.imageModel = { primary: imageModel };
  }

  // Build agents list with OpenClaw-side workspace paths, tools.deny, and plugin configs
  const pluginConfigs: Record<string, Record<string, Record<string, unknown>>> = {};
  let contextPluginAgents: Record<string, { tools: string[]; userId: string }> | undefined;

  const agentsList = liveAgents.map((agent) => {
    const agentEntry: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      workspace: getOpenClawWorkspacePath(agent.id),
      // Disable heartbeat by default: it fires LLM calls in the background
      // and racks up tokens even for idle agents. Set per-agent (NOT in
      // agents.defaults) to avoid hot-reload races with Telegram (openclaw#47458).
      heartbeat: { every: "0m" },
    };

    // Issue #373: size the per-agent bootstrap caps to the agent's on-disk
    // instruction files. OpenClaw's prompt bootstrap caps each embedded file at
    // 12k chars (60k total) and replaces the overflow with a "…truncated…"
    // marker — which both starves the model of the tail of its own AGENTS.md and
    // leaks the marker into output when the agent reproduces its instructions.
    // The per-agent override is checked before agents.defaults, so it avoids the
    // agents.defaults hot-reload race (openclaw#47458). Only emitted when the
    // files actually exceed OpenClaw's defaults.
    const bootstrapCaps = resolveBootstrapCaps(getAgentBootstrapSizes(agent.id));
    if (bootstrapCaps.bootstrapMaxChars !== undefined) {
      agentEntry.bootstrapMaxChars = bootstrapCaps.bootstrapMaxChars;
    }
    if (bootstrapCaps.bootstrapTotalMaxChars !== undefined) {
      agentEntry.bootstrapTotalMaxChars = bootstrapCaps.bootstrapTotalMaxChars;
    }
    if (bootstrapCaps.oversized) {
      console.warn(
        `[openclaw-config] Agent ${agent.name} (${agent.id}) has bootstrap instruction files larger than the protective ceiling; OpenClaw will still truncate them and the agent may not see all of its AGENTS.md. Consider splitting the instructions or moving reference material into a knowledge base.`
      );
    }

    // Compute denied tool groups from allowed tools
    const allowedTools = (agent.allowedTools as string[]) || [];
    const deniedGroups = computeDeniedGroups(allowedTools);
    if (deniedGroups.length > 0) {
      agentEntry.tools = { deny: deniedGroups };
    }

    // Confine the built-in `pdf` and `image` tools to the agent's own
    // workspace directory. Without this, the tools would have unrestricted
    // host-filesystem access. See CISO-review note in PR #316.
    agentEntry.tools = {
      ...((agentEntry.tools as Record<string, unknown>) ?? {}),
      fs: { workspaceOnly: true },
    };

    // pinchy-files: always inject workspace uploads + workbench; merge with
    // admin-configured KB paths. `uploads/` is the user's zone (chat
    // attachments); `workbench/` is the agent's writable zone for pinchy_write.
    // Both are read+write so an agent can revisit deliverables it produced
    // earlier (#418).
    const adminFilesConfig = (agent.pluginConfig as AgentPluginConfig)?.["pinchy-files"];
    const adminPaths: string[] = adminFilesConfig?.allowed_paths ?? [];
    const workspaceUploads = `${getOpenClawWorkspacePath(agent.id)}/uploads`;
    const workspaceWorkbench = `${getOpenClawWorkspacePath(agent.id)}/workbench`;
    const allowedPaths = [...adminPaths, workspaceUploads, workspaceWorkbench];

    if (!pluginConfigs["pinchy-files"]) pluginConfigs["pinchy-files"] = {};

    const agentFilesConfig: Record<string, unknown> = { allowed_paths: allowedPaths };
    if (allowedTools.includes("pinchy_write")) {
      // Persistent agent memory (OpenClaw-managed): MEMORY.md holds curated
      // long-term knowledge, memory/ holds daily logs. A write-capable agent
      // gets them so it can actually persist what the user tells it to
      // remember — without a write path it sees memory_search but can never
      // write, which led agents to hallucinate saved memories (#368).
      //
      // MEMORY.md is granted as a FILE, not the workspace root: the
      // trailing-slash boundary in pinchy-files validate.ts makes the entry
      // match exactly that file and NOT its siblings (SOUL.md, AGENTS.md,
      // IDENTITY.md, USER.md), so the agent can rewrite its memory but never
      // its identity or instructions. memory/ is a directory entry (subtree).
      const workspaceMemoryFile = `${getOpenClawWorkspacePath(agent.id)}/MEMORY.md`;
      const workspaceMemoryDir = `${getOpenClawWorkspacePath(agent.id)}/memory`;

      // Both lists: write_paths ⊆ allowed_paths is enforced build-time
      // (validate-built-config.ts) and runtime (pinchy-files validate.ts).
      agentFilesConfig.allowed_paths = [...allowedPaths, workspaceMemoryFile, workspaceMemoryDir];

      // uploads/ stays writable for backward-compat with existing custom
      // AGENTS.md that told the agent to write there. New guidance points
      // agents at workbench/.
      agentFilesConfig.write_paths = [
        workspaceUploads,
        workspaceWorkbench,
        workspaceMemoryFile,
        workspaceMemoryDir,
      ];
    }
    pluginConfigs["pinchy-files"][agent.id] = agentFilesConfig;

    // Collect plugin config for agents that have context tools (pinchy_save_*)
    const contextTools = allowedTools.filter((t: string) => t.startsWith("pinchy_save_"));
    if (contextTools.length > 0 && agent.ownerId) {
      if (!contextPluginAgents) {
        contextPluginAgents = {};
      }
      contextPluginAgents[agent.id] = {
        tools: contextTools.map((t: string) => t.replace("pinchy_", "")),
        userId: agent.ownerId,
      };
    }

    // Skills (master issue #543). The allowlist is ALWAYS emitted — even
    // empty — because an absent `skills` field lets OC's 58 bundled desktop
    // skills (1password, apple-notes, ...) into Pinchy agents. An explicit
    // `skills: []` excludes them; an explicit list narrows to just our
    // first-party skills. Behavior verified in the smoke-test against OC
    // 2026.6.5: empty list → 0/59 ready, all "excluded".
    //
    // The `?? []` is defense-in-depth. Migration 0040 set the column to
    // `notNull().default('[]')`, so at runtime the value is never null for
    // an inserted row — but Drizzle's type still allows it, and an
    // in-flight insert that races a regenerate could otherwise surface as
    // an opaque TypeError instead of a clean empty allowlist.
    const rawSkills = (agent.skills as string[] | null) ?? [];
    const skills: string[] = [];
    for (const id of rawSkills) {
      if (!isKnownSkill(id)) {
        throw new Error(
          `Agent ${agent.name} (${agent.id}) references unknown skill: ${id}. Add it to KNOWN_SKILLS or remove from agent.skills.`
        );
      }
      skills.push(id);
    }
    agentEntry.skills = skills;

    return agentEntry;
  });

  // Materialize SKILL.md files into each agent's workspace AFTER the entry
  // map. Two reasons to do it in a second pass rather than inside .map():
  //
  //   1. `.map()` is supposed to be pure; emitting side effects from inside
  //      it surprises both linters and reviewers.
  //   2. We skip soft-deleted agents here. Pre-existing behavior writes
  //      pinchy-files config for all agents (incl. tombstoned ones), but
  //      that's an upstream issue. Materializing skill files into stale
  //      workspaces would only add to the litter — there is no reader for
  //      those files anyway since OC won't be told the agent exists once
  //      the user-delete flow rms the workspace.
  for (const agent of liveAgents) {
    if (agent.deletedAt) continue;
    const rawSkills = (agent.skills as string[] | null) ?? [];
    for (const id of rawSkills) {
      if (!isKnownSkill(id)) continue; // already thrown in the map() above
      // SKILL.md body is process-cached (see getSkillBody), so the same
      // skill across N agents costs one disk read total, not N.
      writeWorkspaceSkill(agent.id, id, getSkillBody(id));
    }
  }

  // Build complete config — gateway and OpenClaw-enriched fields preserved,
  // everything else from DB. OpenClaw adds meta, commands, etc. at startup;
  // removing them would cause unnecessary diffs on every write.
  //
  // Deep-merge agents into existing to preserve OpenClaw-enriched fields
  // (contextPruning, heartbeat, models, compaction) that may not yet be
  // in the config file right after a full restart.
  const existingAgents = (existing.agents as Record<string, unknown>) || {};

  // Spread existing.<field> for each top-level we touch so OpenClaw-enriched
  // sub-fields survive the regenerate. Without this, Pinchy strips whatever
  // OpenClaw stamps under these paths (lastAnnouncedAt, lastCheckedAt,
  // boundPort, peer lists, etc.), the diff classifier flags it as a change,
  // and we get exactly the cascade this PR is meant to close (#193, #237).
  // Same shape as the `existingControlUi` spread on the gateway block above.
  const existingDiscovery = (existing.discovery as Record<string, unknown>) || {};
  const existingMdns = (existingDiscovery.mdns as Record<string, unknown>) || {};
  const existingUpdate = (existing.update as Record<string, unknown>) || {};
  const existingCanvasHost = (existing.canvasHost as Record<string, unknown>) || {};

  // #508: identityLinks is no longer Pinchy-owned. Purge any stale value left by
  // a pre-per-task version so UPGRADES actually un-unify Telegram. We only
  // STOPPED writing it in 2517a0fb; regenerate spreads the on-disk session,
  // which would otherwise preserve a baked-in identityLinks forever — OpenClaw
  // keeps folding the linked Telegram peer's DMs into the web session on exactly
  // the prod/demo installs that already have the key. We purge ONLY
  // identityLinks; every other (OC-enriched) session key is preserved.
  const existingSessionPurged = { ...((existing.session as Record<string, unknown>) || {}) };
  delete existingSessionPurged.identityLinks;

  const config: Record<string, unknown> = {
    gateway,
    // Disable OpenClaw's mDNS announcer. Pinchy always runs OpenClaw inside
    // a container; multicast doesn't route out of Docker bridge networks,
    // so the announcer hangs in `state=announcing`. After ~16 s OpenClaw's
    // internal Bonjour watchdog declares the service stuck and SIGTERMs the
    // gateway, costing ~30 s of "Reconnecting to the agent…" downtime per
    // cold start (observed staging 2026-05-03; see openclaw-integration.log
    // entries `[bonjour] restarting advertiser (service stuck in announcing)`).
    // We connect via OPENCLAW_WS_URL on the bridge network and never need
    // mDNS, so turning it off is safe.
    discovery: { ...existingDiscovery, mdns: { ...existingMdns, mode: "off" } },
    // Skip the npm "update available" check on every gateway boot.
    // Pinchy controls the OpenClaw version via the Docker image tag and
    // ignores the notice; the network call is wasted I/O at startup.
    update: { ...existingUpdate, checkOnStart: false },
    // OpenClaw's "canvas" artifact host. Pinchy doesn't render OpenClaw
    // canvases anywhere in its UI; per schema: "Keep disabled when canvas
    // workflows are inactive to reduce exposed local services."
    canvasHost: { ...existingCanvasHost, enabled: false },
    secrets: {
      providers: {
        pinchy: {
          source: "file",
          // OPENCLAW_SECRETS_PATH_IN_OPENCLAW lets integration tests bind-mount
          // the secrets file at a different path inside the OpenClaw container
          // than the one Pinchy writes from the host. In production both
          // containers share the same tmpfs volume, so OPENCLAW_SECRETS_PATH is
          // sufficient and OPENCLAW_SECRETS_PATH_IN_OPENCLAW stays unset.
          path:
            process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW ||
            process.env.OPENCLAW_SECRETS_PATH ||
            "/openclaw-secrets/secrets.json",
          mode: "json",
        },
      },
    },
    agents: deepMerge(existingAgents, {
      defaults: pinchyDefaults,
      list: agentsList,
    }),
    // Disable OpenClaw's default daily session reset (4:00 AM gateway-local
    // time). Pinchy's chat UI loads history via the deterministic session key
    // `agent:<agentId>:direct:<userId>` (see client-router.ts:81 —
    // `computeSessionKey`), and OpenClaw's reset rotates the underlying
    // `sessionId` for that key at the boundary — leaving the old transcript
    // JSONL on disk but unreachable from Pinchy. For users in an enterprise
    // chat context, this looks like their entire conversation vanished
    // every morning; the first user to notice was the one whose cron job
    // ran into the post-reset session and surfaced the empty transcript
    // with the cron message as the only content (see openclaw@2026.5.7
    // dist/reset-L5yC6_6J.js — `const DEFAULT_RESET_MODE = "daily"`).
    //
    // `mode: "idle"` with a very large `idleMinutes` value disables the
    // daily reset without using an invalid config. OpenClaw's schema
    // requires `idleMinutes > 0`; using 525600 (1 year) is valid and
    // practically never triggers. No daily branch fires (mode is not
    // "daily"), and the idle branch only fires after a full year of
    // inactivity. Manual `/new` / `/reset` slash commands are still
    // respected for users who explicitly want a fresh chat — this only
    // disables the silent auto-rotation.
    // Spread existing session fields so OpenClaw-enriched sibling keys are
    // preserved across regenerations (same pattern as gateway, discovery, etc.).
    // Only `reset` is Pinchy-owned; everything else OpenClaw may stamp belongs
    // to OpenClaw and must survive a config regenerate unchanged. `identityLinks`
    // is stripped above (see `existingSessionPurged`, #508); stripping it here
    // cascades to the telegram block below, which spreads this already-assembled
    // `config.session` (not raw `existing.session`), so no second strip is needed.
    session: {
      ...existingSessionPurged,
      reset: { mode: "idle" as const, idleMinutes: 525600 },
    },
  };

  // Preserve OpenClaw-enriched top-level fields that Pinchy doesn't manage
  for (const key of ["meta", "commands"] as const) {
    if (existing[key] !== undefined) {
      config[key] = existing[key];
    }
  }

  const entries: Record<string, unknown> = {};

  // Write gateway token to secrets.json so Pinchy can read it at startup from secrets.json
  const gatewaySecret = gatewayTokenValue ? { token: gatewayTokenValue } : undefined;

  // OpenClaw 2026.4.26 does not resolve SecretRef in plugins.entries.*.config —
  // the validator rejects the config with "gatewayToken: invalid config: must be
  // string". We therefore inline the plain token in plugin configs. Can move to
  // SecretRef once we upgrade OpenClaw to a version that resolves them here.
  const gatewayTokenString = gatewayTokenValue || "";

  // pinchy-files needs apiBaseUrl/gatewayToken so it can report vision API
  // token usage (from scanned-PDF processing) back to Pinchy via
  // /api/internal/usage/record. Unlike pinchy-context which only exposes
  // per-agent `agents`, pinchy-files adds the two top-level keys alongside.
  if (pluginConfigs["pinchy-files"]) {
    // Dedicated vision model for pinchy_read's scanned-page description. Same
    // best-live-vision-model resolution as the (legacy) built-in image tool,
    // but consumed by our own plugin — so it works on every provider/version
    // and, resolved against the live /v1/models catalog, never points at a
    // retired model. This is a single provider-default pick (e.g. Anthropic →
    // Haiku), NOT the per-agent chat model — matching the old pdfModel/imageModel
    // behaviour. Omitted when no vision provider is configured; the plugin then
    // falls back to the agent's own model.
    const visionModel = await resolveDefaultImageModel();
    entries["pinchy-files"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        ...(visionModel ? { visionModel } : {}),
        agents: pluginConfigs["pinchy-files"],
      },
    };
  }

  // Any additional plugins collected via pluginConfigs get the generic
  // shape (no apiBaseUrl/gatewayToken). Today this branch is empty; it
  // exists to keep the pluginConfigs abstraction for future per-agent plugins.
  for (const [pluginId, agentConfigs] of Object.entries(pluginConfigs)) {
    if (pluginId === "pinchy-files") continue;
    entries[pluginId] = {
      enabled: true,
      config: {
        agents: agentConfigs,
      },
    };
  }

  // Enable pinchy-docs for all personal agents (Smithers) so they can read
  // platform documentation on demand. The plugin scopes itself to listed agents.
  const personalAgentIds = liveAgents.filter((a) => a.isPersonal).map((a) => a.id);
  if (personalAgentIds.length > 0) {
    // Three-state setting (see DOCS_PUBLIC_BASE_URL_SETTING_KEY doc-comment):
    // unset → default, empty → opt-out, value → use as-is.
    const docsBaseUrlSetting = await getSetting(DOCS_PUBLIC_BASE_URL_SETTING_KEY);
    const docsConfig: Record<string, unknown> = {
      docsPath: "/pinchy-docs",
      agents: Object.fromEntries(personalAgentIds.map((id) => [id, {}])),
    };
    const resolvedDocsBaseUrl =
      docsBaseUrlSetting === null ? DEFAULT_DOCS_PUBLIC_BASE_URL : docsBaseUrlSetting;
    if (resolvedDocsBaseUrl) {
      docsConfig.publicBaseUrl = resolvedDocsBaseUrl;
    }
    entries["pinchy-docs"] = {
      enabled: true,
      config: docsConfig,
    };
  }

  // Only include pinchy-context when agents use it. Including disabled plugins
  // with config causes OpenClaw to spam "disabled in config but config is present".
  if (contextPluginAgents) {
    entries["pinchy-context"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: contextPluginAgents,
      },
    };
  }

  // Always include pinchy-audit and keep it enabled. It logs tool usage from
  // OpenClaw hooks so built-in and custom tools are captured at source.
  entries["pinchy-audit"] = {
    enabled: true,
    config: {
      apiBaseUrl: process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
      gatewayToken: gatewayTokenString,
    },
  };

  // Always include pinchy-transcript and keep it enabled. It captures inbound/
  // outbound channel messages (message_received / message_sent hooks) into
  // Pinchy's durable transcript store so the read-only conversation mirror
  // survives OpenClaw session resets.
  entries["pinchy-transcript"] = {
    enabled: true,
    config: {
      apiBaseUrl: process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
      gatewayToken: gatewayTokenString,
    },
  };

  // Note: pinchy-files is always included (workspace uploads) — per-agent paths are built above.

  // Collect Odoo integration configs for agents with integration permissions
  // Only include active connections — pending ones have no usable credentials
  const allPermissions = await db
    .select()
    .from(agentConnectionPermissions)
    .innerJoin(
      integrationConnections,
      eq(agentConnectionPermissions.connectionId, integrationConnections.id)
    )
    .where(ne(integrationConnections.status, "pending"));

  const odooAgentConfigs: Record<string, Record<string, unknown>> = {};
  const integrationSecrets: SecretsBundle["integrations"] = {};
  const permsByAgent = new Map<
    string,
    Map<
      string,
      { connection: typeof integrationConnections.$inferSelect; ops: Map<string, string[]> }
    >
  >();

  for (const row of allPermissions) {
    const perm = row.agent_connection_permissions;
    const conn = row.integration_connections;

    if (conn.type !== "odoo") continue;

    if (!permsByAgent.has(perm.agentId)) {
      permsByAgent.set(perm.agentId, new Map());
    }
    const agentPerms = permsByAgent.get(perm.agentId)!;

    if (!agentPerms.has(perm.connectionId)) {
      agentPerms.set(perm.connectionId, { connection: conn, ops: new Map() });
    }
    const connPerms = agentPerms.get(perm.connectionId)!;

    if (!connPerms.ops.has(perm.model)) {
      connPerms.ops.set(perm.model, []);
    }
    connPerms.ops.get(perm.model)!.push(perm.operation);
  }

  // Build plugin config per agent (using first connection — single connection per agent for now)
  for (const [agentId, connections] of permsByAgent) {
    const [firstConnection] = connections.values();
    if (!firstConnection) continue;

    const conn = firstConnection.connection;

    const permissions: Record<string, string[]> = {};
    for (const [model, ops] of firstConnection.ops) {
      permissions[model] = ops;
    }

    // Build lightweight model name map — only for models with permissions
    // (no field schemas — those are fetched live by the plugin via fields_get())
    const modelNames: Record<string, string> = {};
    if (conn.data && typeof conn.data === "object") {
      const data = conn.data as {
        models?: Array<{ model: string; name: string }>;
      };
      if (data.models) {
        for (const m of data.models) {
          if (permissions[m.model]) {
            modelNames[m.model] = m.name;
          }
        }
      }
    }

    // No credentials in plugin config. The plugin fetches them on demand
    // from /api/internal/integrations/<connectionId>/credentials with the
    // gateway token. See packages/plugins/pinchy-odoo/index.ts and
    // packages/web/src/app/api/internal/integrations/[connectionId]/credentials/route.ts.
    // This keeps openclaw.json free of long-lived per-tenant secrets and
    // lets Pinchy own rotation, audit, and per-agent authorization
    // centrally — same pattern as pinchy-email. See #209 for the bug
    // that motivated the migration away from SecretRef-in-plugin-config.
    odooAgentConfigs[agentId] = {
      connectionId: conn.id,
      permissions,
      modelNames,
    };
  }

  if (Object.keys(odooAgentConfigs).length > 0) {
    entries["pinchy-odoo"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: odooAgentConfigs,
      },
    };
  }

  // Collect web search configs
  const webSearchConnections = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.type, "web-search"));

  if (webSearchConnections.length > 0) {
    const webConn = webSearchConnections[0];

    const webAgentConfigs: Record<string, Record<string, unknown>> = {};

    for (const agent of liveAgents) {
      const allowedTools = (agent.allowedTools as string[]) || [];
      const hasWebSearch = allowedTools.includes("pinchy_web_search");
      const hasWebFetch = allowedTools.includes("pinchy_web_fetch");

      if (hasWebSearch || hasWebFetch) {
        const webConfig = (agent.pluginConfig as AgentPluginConfig)?.["pinchy-web"] ?? {};
        const tools: string[] = [];
        if (hasWebSearch) tools.push("pinchy_web_search");
        if (hasWebFetch) tools.push("pinchy_web_fetch");

        webAgentConfigs[agent.id] = { tools, ...webConfig };
      }
    }

    if (Object.keys(webAgentConfigs).length > 0) {
      // No braveApiKey in plugin config. The plugin fetches it on demand
      // from the credentials API — same pattern as pinchy-odoo / pinchy-email.
      // See #209 for the bug class motivated this migration.
      entries["pinchy-web"] = {
        enabled: true,
        config: {
          apiBaseUrl:
            process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
          gatewayToken: gatewayTokenString,
          connectionId: webConn.id,
          agents: webAgentConfigs,
        },
      };
    }
  }

  // Collect email integration configs for agents with email provider permissions.
  // Unlike Odoo, email config does NOT include decrypted credentials — only
  // connectionId + permissions. The plugin fetches credentials at runtime via
  // the internal API (API-callback pattern).
  const EMAIL_PROVIDER_TYPES = new Set(["google", "microsoft", "imap"]);
  const emailPermsByAgent = new Map<string, { connectionId: string; ops: Map<string, string[]> }>();

  for (const row of allPermissions) {
    const perm = row.agent_connection_permissions;
    const conn = row.integration_connections;

    if (!EMAIL_PROVIDER_TYPES.has(conn.type)) continue;

    if (!emailPermsByAgent.has(perm.agentId)) {
      emailPermsByAgent.set(perm.agentId, {
        connectionId: perm.connectionId,
        ops: new Map(),
      });
    }
    const agentPerms = emailPermsByAgent.get(perm.agentId)!;

    if (!agentPerms.ops.has(perm.model)) {
      agentPerms.ops.set(perm.model, []);
    }
    agentPerms.ops.get(perm.model)!.push(perm.operation);
  }

  const emailAgentConfigs: Record<
    string,
    { connectionId: string; permissions: Record<string, string[]> }
  > = {};
  for (const [agentId, data] of emailPermsByAgent) {
    const permissions: Record<string, string[]> = {};
    for (const [model, ops] of data.ops) {
      permissions[model] = ops;
    }
    emailAgentConfigs[agentId] = {
      connectionId: data.connectionId,
      permissions,
    };
  }

  if (Object.keys(emailAgentConfigs).length > 0) {
    entries["pinchy-email"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: emailAgentConfigs,
      },
    };
  }

  // Build the allow list. Two requirements:
  //   1. Include every plugin we have entries for (pinchy-*) and every
  //      OpenClaw-managed plugin (e.g. "telegram") already in the list.
  //   2. Preserve the existing positional order. OpenClaw treats
  //      `plugins.allow` as restart-required: a reorder triggers a full
  //      gateway restart even when the SET of plugins is unchanged. The
  //      previous implementation rebuilt allow as
  //      `[...existing-non-pinchy, ...our-pinchy-in-insertion-order]`,
  //      which reshuffles the array whenever OpenClaw appended one of its
  //      managed plugins after Pinchy's first write (e.g. `telegram` after
  //      `connectBot`). The next regenerate then moved telegram to position 0
  //      and re-ordered pinchy-* entries — same set, restart cascade. See #237.
  // We must NOT include Pinchy plugins without entries — OpenClaw validates
  // their config schema and rejects missing required fields like "agents".
  const existingAllow = ((existing.plugins as Record<string, unknown>)?.allow as string[]) || [];
  const ourPlugins = new Set(Object.keys(entries));
  const pinchyPluginPrefixes = ["pinchy-"];
  const isPinchyPlugin = (p: string) => pinchyPluginPrefixes.some((prefix) => p.startsWith(prefix));
  // OpenClaw 2026.4.x ships several plugins enabledByDefault that Pinchy
  // never uses but whose runtime deps still get installed on the first
  // gateway boot (~48s on a 2-vCPU host, observed staging 2026-05-04).
  // `plugins.allow` is a hard whitelist per the OpenClaw schema:
  // "when set, only listed plugins are eligible to load". Keeping these
  // four IDs out of `allow` blocks load and the dep install entirely.
  //
  // We deliberately do NOT also stamp `plugins.entries.<id>.enabled = false`.
  // OpenClaw enriches `plugins.entries.*` at runtime (sibling fields like
  // hooks/subagent state); writing our own value over the existing entry
  // would either drop those enrichments (-> next regenerate diffs `plugins`
  // -> full SIGUSR1 gateway restart, caught by agent-create-no-restart.
  // spec.ts:207) or write a new entry that wasn't there before (-> first
  // regenerate diffs `plugins` -> restart). The allowlist alone is the
  // correct mechanism here.
  //
  // Why each is safe to disable:
  //   - acpx: Agent Client Protocol bridge for desktop chat clients
  //     (Claude.app, Zed Codex). Pinchy talks to OpenClaw via openclaw-node
  //     over its WebSocket gateway, never via ACP.
  //   - bonjour: mDNS gateway advertiser. Pinchy reaches OpenClaw on the
  //     Docker bridge via OPENCLAW_WS_URL; multicast doesn't route there.
  //     `discovery.mdns.mode = "off"` already silences the watchdog but
  //     still loads ~1MB @homebridge/ciao deps and starts an announcer.
  //   - device-pair: QR-code device pairing UX. Pinchy auto-approves
  //     devices with the gateway token in start-openclaw.sh.
  //   - phone-control: arms/disarms phone-node high-risk commands. Pinchy
  //     has no phone integration.
  //
  // Plugins we keep on (despite Pinchy not using them yet):
  //   - browser: planned feature. The `browser`/`canvas` tools live in
  //     OpenClaw's `group:ui`, which the tool-registry deny-list denies for
  //     every agent (see ALL_GROUPS + the drift guard), so the plugin can load
  //     here without any agent reaching the real browser until we add an
  //     explicit per-agent opt-in.
  //   - memory-core: activation.onStartup=false; lazy and free at startup.
  //   - talk-voice: leaf TTS-voice picker; tiny, future voice work.
  // Bundled OpenClaw extensions that Pinchy depends on but that aren't
  // otherwise visible to the build (no `entries` written, not in
  // `existingAllow` on first boot). Without explicit inclusion in
  // plugins.allow they are blocked by the whitelist and the dependent
  // built-in tools fail at runtime.
  //   - document-extract: PDF text + image extraction backend used by the
  //     built-in `pdf` tool's extraction fallback mode (pdfjs-dist).
  const REQUIRED_BUNDLED_PLUGINS = ["document-extract"] as const;

  const DISABLED_OPENCLAW_PLUGINS = new Set(["acpx", "bonjour", "device-pair", "phone-control"]);
  const isWanted = (p: string) =>
    !DISABLED_OPENCLAW_PLUGINS.has(p) && (!isPinchyPlugin(p) || ourPlugins.has(p));
  // Keep existing entries (in their current positions) that we still want.
  // Drops stale pinchy-* entries we no longer emit; preserves OpenClaw-
  // managed plugins as-is.
  const preservedOrder: string[] = [];
  const seen = new Set<string>();
  for (const plugin of existingAllow) {
    if (isWanted(plugin) && !seen.has(plugin)) {
      preservedOrder.push(plugin);
      seen.add(plugin);
    }
  }
  // Append any pinchy-* plugin newly added since the last write. New
  // additions go at the end so the positions of pre-existing entries stay
  // stable (no spurious diff for unrelated plugins).
  const newAdditions = [...ourPlugins].filter((p) => !seen.has(p));
  // Include required bundled plugins that aren't already in the list
  const requiredAdditions = [...REQUIRED_BUNDLED_PLUGINS].filter((p) => !seen.has(p));
  const allowedPlugins = [...preservedOrder, ...newAdditions, ...requiredAdditions];

  // Preserve OpenClaw-managed plugin entries that we don't write ourselves.
  // OpenClaw auto-enables each configured provider (anthropic, openai, google,
  // ollama-cloud) and the telegram channel by writing
  // `plugins.entries.<id> = { enabled: true }` into openclaw.json on startup.
  // Without this preservation the next regenerate strips those entries,
  // OpenClaw treats it as a config diff and triggers a full gateway restart
  // (15-30 s downtime, "Agent runtime is not available" banner — #193).
  // Same root cause as the channels.telegram.enabled fix above; this covers
  // the plugins.entries.* surface.
  const existingEntries =
    ((existing.plugins as Record<string, unknown>)?.entries as Record<string, unknown>) || {};
  // Preserve all existing non-pinchy entries — including ones for plugins
  // we've filtered out of `plugins.allow` (acpx/bonjour/...). Stripping
  // them would diff `plugins` and OpenClaw classifies that as restart-
  // required (caught by agent-create-no-restart.spec.ts:207). The allow
  // whitelist alone keeps them from loading, so leftover entries are inert.
  for (const [pluginId, entry] of Object.entries(existingEntries)) {
    if (!isPinchyPlugin(pluginId) && !(pluginId in entries)) {
      entries[pluginId] = entry;
    }
  }

  if (allowedPlugins.length > 0 || Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  // Build models.providers block — built-in providers + Ollama providers.
  // Built-in providers (anthropic, openai, google) use SecretRef for apiKey
  // so OpenClaw resolves the key live from secrets.json without a restart.
  const ollamaCloudKey = await getSetting(PROVIDERS["ollama-cloud"].settingsKey);
  const ollamaLocalUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);

  const modelProviders: Record<string, unknown> = {};

  // OC 5.x changed models.providers.* to require `baseUrl` for ALL built-in
  // providers (breaking change from 4.x where it was optional). Without
  // baseUrl, the gateway fails to start on health-check restarts:
  //   "models.providers.anthropic.baseUrl: Invalid input: expected string, received undefined"
  //
  // Priority for the emitted baseUrl:
  //   1. PINCHY_PROVIDER_BASEURL_*  — Pinchy's own host override, used by
  //      the LLM mock in E2E/smoke tests so OpenClaw's chat traffic hits the
  //      local stand-in instead of api.openai.com etc. The path suffix
  //      (BUILTIN_PROVIDER_PATH_SUFFIX) is appended to keep OC's URL shape.
  //   2. *_BASE_URL (SDK convention) — used by proxy customers in production.
  //      The value comes through verbatim because SDK env vars already carry
  //      the full path (e.g. https://my-proxy.example.com/v1). No double-
  //      suffix. Covered by the regression tests immediately above.
  //   3. Bare built-in host + path suffix — OC's canonical default.
  for (const providerName of ["anthropic", "openai", "google"] as const) {
    const apiKey = await getSetting(PROVIDERS[providerName].settingsKey);
    if (apiKey) {
      // PINCHY_PROVIDER_BASEURL_* carries only the host, so we append the
      // path suffix to keep the OC URL shape. The SDK *_BASE_URL fallback
      // only kicks in when the PINCHY var is unset; its value comes through
      // verbatim because SDK convention is to include the full path
      // (e.g. https://my-proxy.example.com/v1).
      const pinchyOverride = process.env[`PINCHY_PROVIDER_BASEURL_${providerName.toUpperCase()}`];
      const sdkOverride = process.env[BUILTIN_PROVIDER_BASE_URL_ENV_VARS[providerName]];
      let baseUrl: string;
      if (pinchyOverride) {
        baseUrl = pinchyOverride + BUILTIN_PROVIDER_PATH_SUFFIX[providerName];
      } else if (sdkOverride) {
        baseUrl = sdkOverride;
      } else {
        baseUrl =
          BUILTIN_PROVIDER_DEFAULT_BASE_URLS[providerName] +
          BUILTIN_PROVIDER_PATH_SUFFIX[providerName];
      }
      modelProviders[providerName] = {
        apiKey: secretRef(`/providers/${providerName}/apiKey`),
        api: BUILTIN_PROVIDER_API[providerName],
        baseUrl,
        models: getModelCatalogForProvider(providerName).map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ vision: _v, ...ocFields }) => ocFields
        ),
      };
    }
  }

  if (ollamaCloudKey) {
    providerSecrets["ollama-cloud"] = { apiKey: ollamaCloudKey };
    modelProviders["ollama-cloud"] = {
      // PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD redirects OpenClaw's Ollama-Cloud
      // chat traffic to the smoke-test LLM mock. Ollama-Cloud has no SDK env-
      // var convention, so the override goes straight through resolveProvider-
      // BaseUrl() with the canonical https://ollama.com fallback.
      baseUrl: resolveProviderBaseUrl("ollama-cloud", "https://ollama.com") + "/v1",
      apiKey: secretRef("/providers/ollama-cloud/apiKey"),
      api: "openai-completions",
      // Derived from TOOL_CAPABLE_OLLAMA_CLOUD_MODELS — see that file for
      // the source of each capability (ollama.com/library/<name>).
      //
      // `compat.supportsUsageInStreaming: true` is REQUIRED for usage
      // tracking. OpenClaw's default compat detection treats any configured
      // non-OpenAI endpoint as not supporting usage-in-streaming, so it
      // never sends `stream_options: { include_usage: true }`. Ollama Cloud
      // only emits the final usage chunk when that flag is present — without
      // this opt-in, every session has zero tracked tokens and Usage & Costs
      // stays empty. Verified live against https://ollama.com/v1/chat/completions.
      //
      // `reasoning`, `input`, and `cost` are required fields of OpenClaw's
      // ModelDefinitionConfig. Cost is zero because Ollama Cloud bills by
      // subscription plan, not per token — a fabricated rate would mislead
      // users reading the Usage dashboard.
      models: TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.map((m) => ({
        id: m.id,
        name: m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        input: m.vision ? ["text", "image"] : ["text"],
        cost: { ...OLLAMA_CLOUD_COST },
        compat: { supportsUsageInStreaming: true },
      })),
    };
  }

  if (ollamaLocalUrl) {
    const ollamaModels = await fetchOllamaLocalModelsFromUrl(ollamaLocalUrl);
    const providerConfig: Record<string, unknown> = {
      baseUrl: rewriteOllamaHostForOpenClaw(ollamaLocalUrl),
      // OC 2026.5.x ships an SSRF guard that blocks fetches to RFC 1918 /
      // loopback / .local addresses by default (log fingerprint:
      // "SsrFBlockedError: Blocked hostname or private/internal/special-use
      // IP address"). For a self-hosted Ollama this is the expected target
      // (host.docker.internal / 192.168.x.x / ollama.local), so opt the
      // ollama-local provider into the private-network allowlist via the
      // provider's `request` sub-block — that's where OC's
      // `ConfiguredModelProviderRequest` schema accepts the flag (sibling
      // of headers/auth/proxy/tls). Other built-in providers stay on the
      // default-deny because they all resolve to public registries.
      request: { allowPrivateNetwork: true },
      // Use openai-completions (not "ollama") so pi-ai's built-in provider handles
      // the stream. The "ollama" api type requires OpenClaw's bundled Ollama runtime
      // plugin to register itself with pi-ai dynamically — that registration only
      // happens via OpenClaw's native setup wizard (credential store: ollama:default
      // profile), not when configured via Pinchy's custom openclaw.json config.
      // Without registration, pi-ai throws "No API provider registered for api: ollama".
      // Ollama's OpenAI-compatible endpoint (/v1/chat/completions) is functionally
      // equivalent and already supported by pi-ai as a built-in.
      api: "openai-completions",
      // OpenClaw 2026.4.27 requires models.length > 0 for the synthetic-local-key
      // path (model-auth-CsyLGY9m.js:130-132). Without at least one entry, OpenClaw
      // falls through to "No API key found for provider 'ollama'".
      models: ollamaModels.map((m) => {
        // Use the bare model id as both `id` and `name`. Pinchy's display label
        // (m.name = "qwen2.5:7b (7B)") looks nicer, but switching `name` to
        // that value tripped a runtime drift in OpenClaw 2026.4.27 — the
        // 5-iteration idempotency stress test (00-config-idempotency.spec.ts)
        // saw the file flip to root:0600 (gateway SIGUSR1 restart) on the
        // first PATCH after setup. Investigation showed OpenClaw's diff
        // classifier treats model `name` changes as restart-required even
        // when the rest of the config is byte-equal. m.name stays UI-only.
        const bareId = m.id.replace(/^ollama\//, "");
        // Real context window when /api/show reported one (Ollama with model_info
        // support); fall back to a safe default for older Ollama versions.
        const contextWindow = m.contextLength ?? OLLAMA_LOCAL_DEFAULT_CONTEXT_WINDOW;
        // Cap maxTokens at the model's context — small-context models would
        // otherwise advertise more output than they can produce.
        const maxTokens = Math.min(OLLAMA_LOCAL_MAX_TOKENS_CAP, contextWindow);
        return {
          id: bareId,
          name: bareId,
          input: m.capabilities.vision ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
        };
      }),
    };
    if (process.env.PINCHY_E2E_OLLAMA_LOCAL_API_KEY === "1") {
      providerSecrets["ollama-local"] = { apiKey: "dummy-integration-test-key" };
      providerConfig.apiKey = secretRef("/providers/ollama-local/apiKey");
    }
    modelProviders["ollama"] = providerConfig;
  }

  if (Object.keys(modelProviders).length > 0) {
    (config as Record<string, unknown>).models = { providers: modelProviders };
  }

  // Build Telegram channel config from DB settings using OpenClaw's multi-account format.
  // Each agent with a bot token gets its own account. Bindings route via accountId.
  //
  // NOTE: allowFrom is NOT written here. It's managed via per-account allow-from
  // store files (credentials/telegram-<accountId>-allowFrom.json) to avoid
  // triggering the broken channel restart (openclaw/openclaw#47458).
  const accounts: Record<string, { botToken: string }> = {};
  interface TelegramBinding {
    agentId: string;
    match: { channel: string; accountId: string; peer?: { kind: string; id: string } };
  }
  const bindings: TelegramBinding[] = [];
  const personalBotsAccountIds: Array<{ accountId: string; ownerId: string | null }> = [];

  for (const agent of liveAgents) {
    const botToken = await getSetting(`telegram_bot_token:${agent.id}`);
    if (botToken) {
      accounts[agent.id] = { botToken };
      if (agent.isPersonal) {
        // Personal agents: per-user peer bindings will be added below
        personalBotsAccountIds.push({ accountId: agent.id, ownerId: agent.ownerId });
      } else {
        // Shared agents: one generic binding per account
        bindings.push({ agentId: agent.id, match: { channel: "telegram", accountId: agent.id } });
      }
    }
  }

  if (Object.keys(accounts).length > 0) {
    const links = await db.select().from(channelLinks);

    // Build per-user peer bindings for personal agents (e.g. Smithers).
    // Each linked user's DMs are routed to THEIR personal agent, not the
    // bot owner's agent. This ensures Telegram conversations match the
    // user's personal Smithers in the web UI.
    if (personalBotsAccountIds.length > 0) {
      const telegramLinks = links.filter((l) => l.channel === "telegram");
      // Map userId → their personal agent ID (hoisted outside loop)
      const personalAgentsByOwner = new Map(
        liveAgents.filter((a) => a.isPersonal).map((a) => [a.ownerId, a.id])
      );

      for (const { accountId } of personalBotsAccountIds) {
        for (const link of telegramLinks) {
          // Route to user's own personal agent, or fall back to the bot owner's agent
          const targetAgentId = personalAgentsByOwner.get(link.userId) || accountId;
          bindings.push({
            agentId: targetAgentId,
            match: {
              channel: "telegram",
              accountId,
              peer: { kind: "dm", id: link.channelUserId },
            },
          });
        }
      }
    }

    // Preserve OpenClaw-enriched channel fields. Use a denylist instead of an
    // allowlist: OC 4.27+ writes additional fields to channels.telegram
    // (e.g. pollingMode) that Pinchy doesn't know about. An allowlist strips
    // those fields → config.apply or inotify sees a channels diff → spurious
    // full gateway restart even for agents-only changes. The denylist preserves
    // all OC-managed fields regardless of OC version. Pinchy-owned fields
    // (enabled, dmPolicy, accounts) are always written fresh below and take
    // precedence over any value in the file.
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    const PINCHY_OWNED_TELEGRAM_FIELDS = new Set(["enabled", "dmPolicy", "accounts"]);
    const preservedTelegram: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existingTelegram)) {
      if (!PINCHY_OWNED_TELEGRAM_FIELDS.has(k)) {
        preservedTelegram[k] = v;
      }
    }
    // Defense in depth: write `enabled: true` actively when we emit the
    // telegram block at all. Pinchy's source of truth is "telegram has
    // ≥1 account configured" → channels.telegram block is emitted; "no
    // accounts" → block is deleted (further down). So whenever the block
    // exists, it should be enabled. Without this active write, the field's
    // presence depends on OpenClaw's auto-enable side-effect having run
    // first, and any regenerate before that side-effect fires would strip
    // it and trigger the ping-pong.
    // OC 2026.5.12's BASE_RELOAD_RULES does not list `channels` — the
    // fallback for unmatched prefixes is restart-class. Any structural
    // diff in the emitted `channels` block (including spurious key-order
    // shifts from spread-then-override and OC-side enrichment ping-pongs)
    // triggers `[reload] config change requires gateway restart (channels)`.
    // Build the telegram channel sub-config the same way as before, then
    // skip the write entirely when the new payload is deep-equal to what's
    // already on disk. The downstream equivalence guard
    // (configsAreEquivalentUpToOpenClawMetadata) covers the whole-config
    // case; this nested guard handles the targeted case where everything
    // BUT channels changed — without it the channels write still produces
    // a same-value-different-key-order diff to OC's file watcher.
    const desiredTelegram = {
      ...preservedTelegram,
      enabled: true,
      dmPolicy: "pairing",
      accounts,
    };
    const existingChannels = (existing.channels as Record<string, unknown>) || {};
    const existingTelegramForCompare = (existingChannels.telegram as Record<string, unknown>) || {};
    if (!isDeepStrictEqual(existingTelegramForCompare, desiredTelegram)) {
      // Real telegram change. Preserve every other channel sub-block OC
      // may have enriched at the top of `channels` (e.g. `defaults` for
      // botLoopProtection / heartbeat-visibility, `modelByChannel`, other
      // channels' configs). Without this spread, writing `{telegram: ...}`
      // alone would strip the OC-enriched siblings and the resulting
      // channels diff still classifies as restart-class (channels has no
      // entry in BASE_RELOAD_RULES; fallback is restart).
      config.channels = { ...existingChannels, telegram: desiredTelegram };
    } else if (Object.keys(existingChannels).length > 0) {
      // No telegram-level change either — pass channels through byte-for-
      // byte to keep OC's file watcher quiet.
      config.channels = existingChannels;
    }
    config.bindings = bindings;
    // Merge into the existing session block — config.session already carries
    // `reset: { mode: "idle", idleMinutes: 0 }` from the initial config
    // assembly above. Overwriting the whole block here would re-enable
    // OpenClaw's default daily session reset whenever telegram is configured,
    // silently losing chat history at 4:00 AM gateway-local time.
    // #508: per-task session model. We intentionally do NOT emit
    // `session.identityLinks`. Emitting it made OpenClaw fold a linked
    // Telegram peer's DMs into the SAME session as the user's web chat
    // (`agent:<id>:direct:<userId>`), which let a Telegram `/new` wipe web
    // history and prevented Telegram from surfacing as its own chat. Without
    // identityLinks each Telegram peer gets its own per-peer session
    // (`agent:<id>:direct:<peerId>`), which the Chats list shows as a
    // read-only "Telegram" chat (attributed via channel_links). `dmScope:
    // "per-peer"` and the reset override stay; the per-user peer bindings
    // above still route each linked user's DMs to their personal agent.
    const existingSession = (config.session as Record<string, unknown>) ?? {};
    config.session = {
      ...existingSession,
      dmScope: "per-peer",
    };
  }

  // Always write secrets.json — tmpfs is wiped on container restart, secrets.json
  // must be present for OpenClaw to resolve SecretRef pointers (provider API keys etc.).
  const { plugins: pluginSecrets } = await collectPluginSecrets();
  const secretsBundle = buildSecretsBundle({
    gateway: gatewaySecret,
    providers: providerSecrets,
    integrations: integrationSecrets,
    plugins: pluginSecrets,
  });

  // Defense in depth: validate every emitted Pinchy plugin entry against its
  // manifest before writing. Catches manifest/build.ts drift at startup rather
  // than letting OpenClaw silently reject the config at hot-reload time.
  //
  // Run validation BEFORE writing secrets.json to disk: both inputs (config and
  // secretsBundle) are in-memory at this point, so neither needs the other to
  // exist on disk first. If validation throws, we want neither file to have been
  // updated — writing secrets.json first leaves a half-updated state when
  // validation later rejects the change.
  const validation = validateBuiltConfig(config, secretsBundle);
  if (!validation.ok) {
    throw new Error(
      "[openclaw-config] Refusing to write invalid plugin config:\n  - " +
        validation.errors.join("\n  - ") +
        "\nFix the plugin manifest or what build.ts emits."
    );
  }

  writeSecretsFile(secretsBundle);

  // Only write if content actually changed — prevents unnecessary OpenClaw restarts.
  // Format must match what OpenClaw's writeConfigFile produces (trimEnd + "\n")
  // so the SHA256 hashes line up. OpenClaw's reload subsystem dedupes
  // chokidar-fired reloads against `lastAppliedWriteHash` (set when
  // config.apply runs); if our file hash equals the apply's hash, the
  // chokidar reload is correctly skipped. Without the trailing newline,
  // hashes diverge and chokidar fires a redundant reload that diffs against
  // a stale `currentCompareConfig` — see #193 / openclaw#75534.
  const newContent = JSON.stringify(config, null, 2).trimEnd() + "\n";
  try {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (existing === newContent) return;
    // Workaround for openclaw#75534: OpenClaw stamps `meta.lastTouchedAt`
    // on every write it performs (config.apply RPC, internal restart
    // bookkeeping). Pinchy preserves `meta` from existing, so back-to-back
    // regenerates with no DB changes still differ on this single field.
    // Without this normalize-compare, sending the byte-different config
    // via config.apply triggers OpenClaw's diff-against-runtime-resolved-
    // snapshot to flag env.* paths as changed (env templates "${VAR}" vs
    // resolved "sk-..."), which falls through `BASE_RELOAD_RULES` to the
    // default full-restart trigger. Result: every settings save costs
    // 15-30 s of "Agent runtime is not available" downtime (#193).
    // Removable when we bump OpenClaw past the upstream fix; tracked in #215.
    if (configsAreEquivalentUpToOpenClawMetadata(existing, newContent)) return;

    // Defense-in-depth size-drop guard (#311). OpenClaw's `config.apply` RPC
    // already rejects writes that shrink the on-disk config by more than 50%
    // (`size-drop:OLD->NEW` error), but Pinchy's `writeConfigAtomic` runs
    // BEFORE `pushConfigInBackground`, so a corrupted regenerate lands on
    // disk and OC's inotify watcher diffs it before the RPC ever runs —
    // triggering a full gateway restart cascade. The trigger pattern: a
    // regenerate runs through a window where DB-derived state isn't fully
    // loaded (telegram_bot_token race in CI flake) and produces a payload
    // missing `channels.telegram` + `bindings`, ~50% smaller than the
    // healthy on-disk file. Mirroring OC's threshold on the Pinchy side
    // keeps the bad payload off disk so the cascade never starts; the next
    // regenerate (from the same or a follow-up request) writes correct
    // content. The bad payload is saved alongside the config for postmortem
    // — silent skip would hide the underlying race forever.
    if (existing.length > 0 && newContent.length < existing.length * 0.5) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rejectedPath = `${CONFIG_PATH}.regenerate-rejected.${ts}`;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is CONFIG_PATH + ISO timestamp, no user input
        writeFileSync(rejectedPath, newContent, { encoding: "utf-8", mode: 0o644 });
      } catch {
        // Best-effort; the warn below carries the salient bytes either way.
      }
      console.error(
        `[openclaw-config] regenerate produced a suspiciously small config ` +
          `(${newContent.length} bytes, was ${existing.length}). ` +
          `Refusing the write to keep OpenClaw's existing state intact. ` +
          `Likely a DB-state-loading race; see #311. ` +
          `Rejected payload saved to ${rejectedPath}.`
      );
      return;
    }
  } catch {
    // File doesn't exist yet — write it
  }

  // Write per-agent auth-profiles.json for agents that use API-key-based
  // providers. Required by OpenClaw ≥ 4.15: each agent directory must
  // contain agents/<id>/agent/auth-profiles.json. We scope each agent to
  // only the provider that matches its own model prefix — writing a profile
  // for a provider the agent doesn't use causes hasAnyAuthProfileStoreSource
  // to return TRUE, which enables strict auth mode and blocks unrelated
  // providers (e.g. ollama-local falls through to an anthropic key check and
  // fails when no anthropic profile exists).
  //
  // Mapping: model prefix (first "/" segment) → AuthProfilesProvider.
  // "ollama" (local) is intentionally absent: URL-based, no API key needed.
  // If an agent would get 0 profiles, writeAgentAuthProfiles removes any
  // existing file to prevent spurious strict-mode activation.
  const MODEL_PREFIX_TO_AUTH_PROFILE: Partial<Record<string, AuthProfilesProvider>> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "gemini",
    "ollama-cloud": "ollama-cloud",
    // "ollama" intentionally absent — local Ollama is URL-based, no API key
  };
  if (process.env.PINCHY_E2E_OLLAMA_LOCAL_API_KEY === "1") {
    MODEL_PREFIX_TO_AUTH_PROFILE.ollama = "ollama-local";
  }
  // Providers that actually have credentials configured right now.
  const PROVIDER_KEY_TO_AUTH_PROFILE: Partial<Record<string, AuthProfilesProvider>> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "gemini",
    "ollama-cloud": "ollama-cloud",
    "ollama-local": "ollama-local",
  };
  const configuredAuthProviders = new Set<AuthProfilesProvider>(
    Object.keys(providerSecrets)
      .map((k) => PROVIDER_KEY_TO_AUTH_PROFILE[k])
      .filter((p): p is AuthProfilesProvider => p !== undefined)
  );

  const configRoot = dirname(CONFIG_PATH);
  for (const agent of liveAgents) {
    const modelPrefix = agent.model?.split("/")[0] ?? "";
    const agentProfileProvider = MODEL_PREFIX_TO_AUTH_PROFILE[modelPrefix];
    const agentProviders: AuthProfilesProvider[] =
      agentProfileProvider && configuredAuthProviders.has(agentProfileProvider)
        ? [agentProfileProvider]
        : [];
    await writeAgentAuthProfiles({
      configRoot,
      agentId: agent.id,
      providers: agentProviders,
    });
  }

  // Push config to OpenClaw. When a WS client is available, config.apply
  // is used for immediate runtime propagation and persists the file itself
  // via OC's inner writeConfigFile. When no WS client (or config.apply
  // fails all retries), writeConfigAtomic writes the file so inotify
  // picks it up (~200 ms in CI, ~60 s on production volumes).
  // Fire-and-forget: the caller must not block on this — config.apply
  // can take 10–30 s when a gateway restart is needed, which broke
  // interactive save flows (Odoo "Save & Restart", UI waits for 200 OK).
  pushConfigInBackground(newContent);
}
