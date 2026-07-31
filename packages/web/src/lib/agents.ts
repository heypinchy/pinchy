export { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";

import { db } from "@/db";
import {
  agents,
  activeAgents,
  agentConnectionPermissions,
  integrationConnections,
  type AgentPluginConfig,
} from "@/db/schema";
import type { AgentVisibility } from "@/db/enums";
import { and, eq } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import {
  deleteWorkspace,
  ensureWorkspace,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  writeIdentityFile,
} from "@/lib/workspace";
import {
  recalculateTelegramAllowStores,
  clearAllowStoreForAccount,
} from "@/lib/telegram-allow-store";
import { deleteSetting, getSetting } from "@/lib/settings";
import { getTemplate, generateAgentsMd } from "@/lib/agent-templates";
import { getPersonalityPreset, resolveGreetingMessage } from "@/lib/personality-presets";
import { generateAvatarSeed } from "@/lib/avatar";
import { validateAllowedPaths } from "@/lib/path-validation";
import { validatePinchyWebConfig } from "@/lib/domain-validation";
import { getContextForAgent } from "@/lib/context-sync";
import { waitForAgentInRuntime } from "@/lib/wait-for-agent-in-runtime";
import { getOpenClawClient } from "@/server/openclaw-client";
import { type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver";
import { resolveAvailableModelForTemplate } from "@/lib/model-resolver/resolve-available";
import type { ModelCapability, ModelHint } from "@/lib/model-resolver/types";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { detectEmailOperations } from "@/lib/tool-registry";
import type { CreateAgentInput } from "@/lib/schemas/agents";

export interface UpdateAgentInput {
  name?: string;
  model?: string;
  allowedTools?: string[];
  pluginConfig?: AgentPluginConfig | null;
  greetingMessage?: string;
  tagline?: string | null;
  starterPrompts?: string[];
  avatarSeed?: string | null;
  personalityPresetId?: string | null;
  visibility?: AgentVisibility;
}

/**
 * List every non-deleted SHARED agent, org-scoped rather than per-user.
 *
 * Backs key-authenticated surfaces (the Agent Provisioning API's
 * `/api/v1/agents`, #572). Session routes MUST keep using `getVisibleAgents`,
 * which filters by the caller's identity.
 *
 * ⚠️ `{ scope: "shared" }` DELIBERATELY BYPASSES per-user visibility: it
 * returns restricted agents the caller shares no group with (design D4). What
 * it does NOT bypass is the personal-agent boundary — see `agent-access.ts`,
 * where the invariant is stated for the session path: personal agents are
 * private to their owner, and that holds for everyone, admins included. An API
 * key is a machine identity for the organization; it has strictly less claim
 * there than an admin, so personal agents are filtered out at the query.
 *
 * There is deliberately NO scope that returns personal agents. The literal is
 * an explicit signal at the call site, and this fails closed on anything else
 * so a mistyped/JS caller — or one left over from the retired `"all"` scope —
 * throws instead of silently widening.
 *
 * Reads from the `active_agents` view, so soft-deleted agents are excluded.
 */
export async function listAgents(opts: {
  scope: "shared";
}): Promise<(typeof activeAgents.$inferSelect)[]> {
  if (opts.scope !== "shared") {
    throw new Error(`listAgents: unsupported scope "${opts.scope}"`);
  }
  return db.select().from(activeAgents).where(eq(activeAgents.isPersonal, false));
}

/**
 * Fetch a single non-deleted SHARED agent by id, org-scoped rather than
 * per-user. The single-agent counterpart to `listAgents` above — same scope
 * semantics, same personal-agent exclusion.
 *
 * Returns `undefined` both when no non-deleted agent has that id AND when the
 * agent is personal, so callers cannot tell the two apart and the route maps
 * both to a plain 404. That symmetry is the point: a distinguishable response
 * would let a key holder enumerate the existence of users' personal agents.
 */
export async function getAgent(
  id: string,
  opts: { scope: "shared" }
): Promise<typeof activeAgents.$inferSelect | undefined> {
  if (opts.scope !== "shared") {
    throw new Error(`getAgent: unsupported scope "${opts.scope}"`);
  }
  const rows = await db
    .select()
    .from(activeAgents)
    .where(and(eq(activeAgents.id, id), eq(activeAgents.isPersonal, false)));
  return rows[0];
}

/**
 * Called by `deleteAgent` the instant the soft-delete is committed, and before
 * the cleanup tail that can still throw. Same contract as `CreateAgentHooks`,
 * for the same reason — see `deleteAgent`.
 */
export type OnAgentDeleted = (agent: typeof agents.$inferSelect) => void;

/**
 * Soft-delete an agent and clean up everything hanging off it.
 *
 * `onDeleted` fires the moment the soft-delete is committed. That timing is
 * the contract: the UPDATE below commits on its own, and every step after it —
 * workspace removal, the grant delete, two `deleteSetting` calls, the OpenClaw
 * regen, the Telegram recalculation — runs outside that transaction and can
 * throw. A caller that awaits this function before registering its audit
 * loses the record of exactly those deletions: the agent is gone, the request
 * 500s, and nothing says who removed it. Pinned by agents-delete.test.ts.
 */
export async function deleteAgent(id: string, onDeleted?: OnAgentDeleted) {
  const [updated] = await db
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

  if (updated) {
    // Committed, and everything below can throw. Record it now.
    onDeleted?.(updated);
    deleteWorkspace(id);
    // Remove the agent's integration grants at the DB level so they can't be
    // re-emitted into the runtime config (the Odoo/email permission loops key
    // off agentConnectionPermissions, not agents.deletedAt).
    await db.delete(agentConnectionPermissions).where(eq(agentConnectionPermissions.agentId, id));
    // Clean up Telegram bot settings if this agent had a bot
    await deleteSetting(`telegram_bot_token:${id}`);
    await deleteSetting(`telegram_bot_username:${id}`);
    clearAllowStoreForAccount(id);
    await regenerateOpenClawConfig();
    await recalculateTelegramAllowStores();
  }

  return updated;
}

const OPENCLAW_CONFIG_FIELDS: (keyof UpdateAgentInput)[] = [
  "name",
  "model",
  "allowedTools",
  "pluginConfig",
];

export async function updateAgent(id: string, data: UpdateAgentInput) {
  const [updated] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();

  const touchesOpenClawConfig = OPENCLAW_CONFIG_FIELDS.some((field) => field in data);
  if (touchesOpenClawConfig) {
    await regenerateOpenClawConfig();
  }

  return updated;
}

/**
 * One integration connection that had permissions auto-configured during agent
 * creation. Delivered to the calling route through `onPermissionsConfigured`
 * the moment the grants commit, so the route can write its `config.changed`
 * entry then rather than after `createAgent` returns — see `CreateAgentHooks`.
 * Also carried on the success result, for callers that only need the summary.
 */
export interface AutoConfiguredConnection {
  connectionId: string;
  permissions: Array<{ model: string; operation: string }>;
}

/** The audit-relevant facts about a creation, known once the row exists. */
export type CreateAgentAuditInfo = {
  templateSkills: string[];
  modelSelection: {
    source: "template-hint" | "provider-default";
    hint: ModelHint | null;
    reason: string;
  };
};

/**
 * Called by `createAgent` the instant the agent row is committed, and before
 * any of the work that can still throw. See `CreateAgentHooks` for why the
 * timing matters.
 */
export type OnAgentCreated = (
  agent: typeof agents.$inferSelect,
  audit: CreateAgentAuditInfo
) => void;

/**
 * Called by `createAgent` the instant one connection's permission grants are
 * committed, and before any of the work that can still throw. Carries the agent
 * rather than making the caller stash it from `onCreated` — that would be a
 * silent ordering dependency between two hooks.
 */
export type OnPermissionsConfigured = (
  agent: typeof agents.$inferSelect,
  entry: AutoConfiguredConnection
) => void;

/**
 * The auditable moments inside `createAgent`, handed to the caller as they
 * happen rather than reported once the function returns.
 *
 * That distinction is the whole point. Every write below commits on its own —
 * nothing here shares a transaction — and the tail after them (workspace
 * materialization, OpenClaw regen, the runtime wait) can throw. A caller that
 * waits for `createAgent` to RETURN before recording anything silently loses
 * the record of every write that already committed: the rows exist, the caller
 * 500s, and nothing was written down. For an audit product that is the one
 * outcome worse than a noisy log.
 *
 * So the service hands each route the moment, and each route brings its own
 * actor (`user` vs `api_key`) and its own writer — which is how `createAgent`
 * stays audit-agnostic without giving up correct timing.
 *
 * Both hooks are pinned by ordering tests in create-agent-service.test.ts; the
 * route-level consequence is pinned in agents-create.test.ts.
 */
export type CreateAgentHooks = {
  onCreated?: OnAgentCreated;
  onPermissionsConfigured?: OnPermissionsConfigured;
};

/**
 * Discriminated result of `createAgent()`. The service performs the domain work
 * and returns structured data; it is auth-, audit-, and HTTP-agnostic. On
 * success it hands back the created agent plus everything the route needs to
 * respond 201. On a validation or capability failure it hands back the exact
 * HTTP status + body the route should return (byte-identical to the
 * pre-extraction inline route), plus — for the capability case — the detail the
 * route needs to write the failure audit.
 *
 * The failure arm is split on `status` so each consumer can narrow to the exact
 * body shape, and so illegal states — a 400 carrying a `capabilityFailure`, or
 * a 422 without one — don't typecheck.
 *
 * `autoConfiguredPermissions` is the same data `onPermissionsConfigured`
 * already delivered, kept here for the return contract. Audit from the hook,
 * not from this field: this field only exists on the path where nothing threw.
 */
export type CreateAgentResult =
  | {
      ok: true;
      agent: typeof agents.$inferSelect;
      audit: CreateAgentAuditInfo;
      autoConfiguredPermissions: AutoConfiguredConnection[];
      // Best-effort OpenClaw runtime apply (#880): the agent row is committed
      // regardless. On regen/runtime-wait failure the create still succeeds
      // (201 at the route); the caller surfaces `runtimeWarning` to the user and
      // audits the apply failure with its own actor. Both undefined ⟹ applied.
      runtimeWarning?: string;
      runtimeApplyError?: string;
    }
  | { ok: false; error: { status: 400; body: { error: string } } }
  | {
      ok: false;
      error: {
        status: 422;
        body: {
          error: "template_capability_unavailable";
          message: string;
          missingCapabilities: ModelCapability[];
          docsUrl: string;
        };
        capabilityFailure: {
          templateId: string;
          missingCapabilities: ModelCapability[];
          // Widened to match main's TemplateCapabilityUnavailableError.provider
          // (#894): resolve-available passes the raw input.provider, which can
          // be a custom OpenAI-compatible slug, not only a built-in ProviderName.
          provider: ProviderName | (string & {});
        };
      };
    };

/**
 * Create an agent from a template. Shared domain service behind both the
 * session-authenticated `POST /api/agents` route and the future
 * key-authenticated `POST /api/v1/agents` route (#572).
 *
 * Performs template resolution + model selection, the DB insert, Odoo/email
 * permission auto-config, workspace materialization, and the OpenClaw regen +
 * runtime wait. It writes NO audit logs and emits NO HTTP responses — instead
 * it returns a discriminated result so each route can wrap it with its own auth,
 * its own audit actor (`user` vs `api_key`), and its own HTTP responses.
 *
 * `ownerId` is the id to record as the agent's owner: the session user for the
 * admin route, and `null` for the key-authenticated API route — a key belongs
 * to the organization rather than to any person (lib/api-key-identity.ts), so
 * there is no honest owner to name. `agents.owner_id` is nullable, and this
 * function never creates personal agents. Writing the creating admin's id here
 * instead would be a lie that outlives them.
 *
 * Two consumers read `ownerId` off a shared agent, and both were checked:
 * `visible-agents` and `agent-access` only consult it on the `isPersonal`
 * branch, so they are unaffected. `openclaw-config/build.ts` does NOT — it
 * gates the `pinchy-context` plugin's per-agent config on a truthy `ownerId`,
 * so an unowned agent carrying a `pinchy_save_*` tool would be offered a tool
 * the plugin has no config for. Unreachable today (no template ships those
 * tools, so it takes an explicit `defaultAllowedTools`), and accepted: the
 * degradation is a missing context entry, not a wrong one. Named here because
 * "unowned is fine" is only true for the consumers that were actually read.
 *
 * See `CreateAgentHooks` for the audit-timing contract.
 */
export async function createAgent(
  input: CreateAgentInput,
  ownerId: string | null,
  hooks?: CreateAgentHooks
): Promise<CreateAgentResult> {
  const { name, templateId, tagline, pluginConfig, connectionId, defaultAllowedTools } = input;

  const template = getTemplate(templateId);
  if (!template) {
    return {
      ok: false,
      error: { status: 400, body: { error: `Unknown template: ${templateId}` } },
    };
  }

  // Validate pinchy-web domain lists (parity with PATCH — agents created with
  // a knowledge-base template may carry a pinchy-web block in pluginConfig
  // alongside pinchy-files.allowed_paths).
  const pluginConfigError = validatePinchyWebConfig(pluginConfig);
  if (pluginConfigError) {
    return { ok: false, error: { status: 400, body: { error: pluginConfigError } } };
  }

  // Only file-access plugin requires directory selection
  if (template.pluginId === "pinchy-files") {
    const paths = pluginConfig?.["pinchy-files"]?.allowed_paths;
    if (!paths || paths.length === 0) {
      return {
        ok: false,
        error: { status: 400, body: { error: "At least one directory must be selected" } },
      };
    }
    try {
      validateAllowedPaths(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid paths";
      return { ok: false, error: { status: 400, body: { error: message } } };
    }
  }

  // Odoo templates require a connection
  if (template.requiresOdooConnection && !connectionId) {
    return {
      ok: false,
      error: { status: 400, body: { error: "An Odoo connection is required for this template" } },
    };
  }

  // Email templates require a connection
  if (template.requiresEmailConnection && !connectionId) {
    return {
      ok: false,
      error: { status: 400, body: { error: "An email connection is required for this template" } },
    };
  }

  // Resolve personality preset from template
  const preset = getPersonalityPreset(template.defaultPersonality);

  // Determine model: use template-aware resolver when modelHint is present,
  // fall back to provider default for templates without a hint (e.g. "custom").
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;

  let model: string;
  let modelSelectionSource: "template-hint" | "provider-default" = "provider-default";
  let modelSelectionReason: string;

  if (template.modelHint && defaultProvider) {
    try {
      const resolved = await resolveAvailableModelForTemplate({
        hint: template.modelHint,
        provider: defaultProvider,
      });
      model = resolved.model;
      modelSelectionReason = resolved.reason;
      modelSelectionSource = "template-hint";
    } catch (err) {
      if (err instanceof TemplateCapabilityUnavailableError) {
        // Audit-agnostic: return the failure detail; the route writes the log.
        return {
          ok: false,
          error: {
            status: 422,
            body: {
              error: "template_capability_unavailable",
              message: err.message,
              missingCapabilities: err.missingCapabilities,
              docsUrl: err.docsUrl,
            },
            capabilityFailure: {
              templateId,
              missingCapabilities: err.missingCapabilities,
              provider: err.provider,
            },
          },
        };
      }
      throw err;
    }
  } else {
    model = defaultProvider
      ? await getDefaultModel(defaultProvider)
      : "anthropic/claude-haiku-4-5-20251001";
    modelSelectionReason = `provider-default (${defaultProvider ?? "anthropic fallback"})`;
  }

  const mergedAllowedTools = [
    ...new Set([...(template.allowedTools ?? []), ...(defaultAllowedTools ?? [])]),
  ];

  // Skills from the template seed the agent's allowlist. Templates without
  // defaultSkills get an empty list — same shape as a pre-migration agent.
  // See master issue #543.
  const templateSkills = [...new Set(template.defaultSkills ?? [])];

  const [agent] = await db
    .insert(agents)
    .values({
      name,
      model,
      templateId,
      pluginConfig: template.pluginId && pluginConfig ? pluginConfig : null,
      ownerId,
      allowedTools: mergedAllowedTools,
      skills: templateSkills,
      // Seed the empty-chat starter chips from the template (#570). Templates
      // without a curated set (e.g. custom) fall back to [] — no chips.
      starterPrompts: template.defaultStarterPrompts ?? [],
      tagline: tagline || template.defaultTagline || null,
      avatarSeed: generateAvatarSeed(),
      personalityPresetId: template.defaultPersonality,
      greetingMessage: resolveGreetingMessage(
        template.defaultGreetingMessage ?? preset?.greetingMessage ?? "Hi {user}. How can I help?",
        name.trim()
      ),
    })
    .returning();

  const auditInfo: CreateAgentAuditInfo = {
    templateSkills,
    modelSelection: {
      source: modelSelectionSource,
      hint: template.modelHint ?? null,
      reason: modelSelectionReason,
    },
  };

  // The agent now exists and is committed. Everything below can throw, and
  // none of it rolls this row back — so the creation gets recorded HERE, not
  // after the function returns. See CreateAgentHooks.
  hooks?.onCreated?.(agent, auditInfo);

  const autoConfiguredPermissions: AutoConfiguredConnection[] = [];

  // Auto-configure Odoo permissions when template has odooConfig
  if (template.odooConfig && connectionId) {
    const connRows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));

    if (connRows.length > 0) {
      const connectionData = connRows[0].data as {
        models?: Array<{
          model: string;
          name: string;
          access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
        }>;
      } | null;
      const models = connectionData?.models ?? [];

      const validation = validateOdooTemplate(template.odooConfig, models);

      if (validation.availableModels.length > 0) {
        const permissionRows = validation.availableModels.flatMap((m) =>
          m.operations.map((op) => ({
            agentId: agent.id,
            connectionId,
            model: m.model,
            operation: op,
          }))
        );

        await db.insert(agentConnectionPermissions).values(permissionRows);

        // Committed, and the tail below can still throw — record it now, for
        // the same reason onCreated fires early. See CreateAgentHooks.
        const entry: AutoConfiguredConnection = {
          connectionId,
          permissions: permissionRows.map((p) => ({ model: p.model, operation: p.operation })),
        };
        autoConfiguredPermissions.push(entry);
        hooks?.onPermissionsConfigured?.(agent, entry);
      }
    }
  }

  // Auto-configure email permissions when template requires email connection
  if (template.requiresEmailConnection && connectionId) {
    const emailOps = detectEmailOperations(template.allowedTools);

    if (emailOps.length > 0) {
      const permissionRows = emailOps.map((op) => ({
        agentId: agent.id,
        connectionId,
        model: "email",
        operation: op,
      }));

      await db.insert(agentConnectionPermissions).values(permissionRows);

      const entry: AutoConfiguredConnection = {
        connectionId,
        permissions: permissionRows.map((p) => ({ model: p.model, operation: p.operation })),
      };
      autoConfiguredPermissions.push(entry);
      hooks?.onPermissionsConfigured?.(agent, entry);
    }
  }

  // Create workspace with personality preset's SOUL.md
  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", preset?.soulMd ?? "");
  writeIdentityFile(agent.id, { name: agent.name, tagline: agent.tagline });
  const agentsMd = generateAgentsMd(
    template,
    template.pluginId && pluginConfig ? pluginConfig : undefined
  );
  if (agentsMd) {
    writeWorkspaceFile(agent.id, "AGENTS.md", agentsMd);
  }
  const context = await getContextForAgent({
    isPersonal: false,
    ownerId,
  });
  writeWorkspaceFileInternal(agent.id, "USER.md", context);

  // Best-effort runtime apply: the agent row is already committed above, so a
  // failed regeneration must NOT surface as a 500 that implies the agent wasn't
  // created (#880) — the UI would show an error while a refresh reveals the
  // agent exists. On failure the create still succeeds; the route returns 201
  // with a non-blocking warning and audits the apply failure with its own
  // actor. OpenClaw reconciles on its next startup / config push.
  let runtimeWarning: string | undefined;
  let runtimeApplyError: string | undefined;
  try {
    await regenerateOpenClawConfig();

    // Wait until OC's runtime has the new agent visible in `agents.list`.
    // Pinchy's regenerate is fire-and-forget (`pushConfigInBackground`) and OC
    // applies the hot reload asynchronously; without this gate the first
    // dispatch after POST /api/agents can race the reload and fail with
    // `invalid agent params: unknown agent id`. Best-effort with a 5 s cap so
    // we don't block the interactive save flow if OC is restarting.
    let client = null;
    try {
      client = getOpenClawClient();
    } catch {
      // OC client not initialised (rare in tests / pre-setup). Skip the wait.
    }
    await waitForAgentInRuntime(client, agent.id);
  } catch (err) {
    console.error("Failed to apply new agent config to the OpenClaw runtime:", err);
    runtimeWarning =
      "Agent created. Applying it to the runtime failed — check the server logs; it will retry on the next restart or config change.";
    runtimeApplyError = err instanceof Error ? err.message : String(err);
  }

  // Same object `onCreated` already received — one source of truth, so a
  // caller using the callback and a caller using the return value can never
  // disagree about what was created.
  return {
    ok: true,
    agent,
    audit: auditInfo,
    autoConfiguredPermissions,
    runtimeWarning,
    runtimeApplyError,
  };
}
