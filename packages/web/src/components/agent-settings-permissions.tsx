"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DirectoryPicker } from "@/components/directory-picker";
import { CircleAlert } from "lucide-react";
import { directoryKey, isSameDirectory, sameDirectorySet } from "@/lib/directory-path";
import {
  getToolsByCategory,
  getOdooToolsForAccessLevel,
  getEmailToolsForOperations,
} from "@/lib/tool-registry";
import { OdooPermissionSection } from "@/components/odoo-permission-section";
import { EmailPermissionSection } from "@/components/email-permission-section";
import { WebSearchPermissionSection } from "@/components/web-search-permission-section";
import { KnowledgeReindexSection } from "@/components/knowledge-reindex-section";
import { ApprovalConfirmationSection } from "@/components/approval-confirmation-section";
import { getConfirmMap, type ConfirmMap } from "@/lib/approvals/policy";
import type { Connection as OdooConnection } from "@/hooks/use-odoo-permissions";
import type { AgentPluginConfig } from "@/db/schema";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { grantedDataPaths } from "@/lib/agent-granted-paths";

export interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: Array<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  }>;
  webSearchConfig?: AgentPluginConfig["pinchy-web"];
  confirm: ConfirmMap;
}

/**
 * Key-by-key, because a confirm map is written from two places (the tool
 * section and the Odoo matrix) and neither controls insertion order — so
 * comparing serialized JSON would report a form as dirty for having reordered.
 */
function sameConfirmMap(a: ConfirmMap, b: ConfirmMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Drop entries for tools the agent may no longer call. A stale key is not
 * merely untidy: revoke a tool, grant it again later, and a confirmation
 * setting nobody can see on the page would come back with it.
 *
 * Resource keys (`odoo_delete:account.move`) are matched on their tool half,
 * so removing a MODEL from the matrix leaves its exception in place — which is
 * deliberate. Models come and go from that grid while the agent's tools stay,
 * and an exception that survives a model being re-added is the kinder answer.
 */
function pruneConfirmMap(confirm: ConfirmMap, allowedTools: string[]): ConfirmMap {
  const allowed = new Set(allowedTools);
  return Object.fromEntries(
    Object.entries(confirm).filter(([key]) => allowed.has(key.split(":")[0]))
  );
}

interface Connection {
  id: string;
  name: string;
  type: string;
  status?: string;
  data?: unknown;
}

const EMAIL_CONNECTION_TYPE_SET = new Set<string>(EMAIL_CONNECTION_TYPES);

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    allowedTools: string[];
    pluginConfig: AgentPluginConfig | null;
  };
  directories: Array<{ path: string; name: string }>;
  connections: Connection[];
  isAdmin: boolean;
  onChange: (values: PermissionsValues, isDirty: boolean) => void;
}

export function AgentSettingsPermissions({
  agent,
  directories,
  connections,
  isAdmin,
  onChange,
}: AgentSettingsPermissionsProps) {
  // KB tools: non-integration safe tools (pinchy_ls / pinchy_read are now implicit — not shown)
  const kbTools = getToolsByCategory("safe").filter((t) => !t.integration);

  // Memory is its own zone and its own section — it is not a knowledge-base
  // concern and never was. It sat under that heading only because this
  // component dumped every non-integration powerful tool there, which is also
  // how the master switch for an agent's memory came to read "Write files"
  // (#755).
  const memoryTools = getToolsByCategory("powerful").filter((t) => t.id === "pinchy_memory");

  // Workspace-write tools shown in their own section: non-integration powerful
  // tools that are not memory.
  const workspaceTools = getToolsByCategory("powerful").filter(
    (t) => !t.integration && t.id !== "pinchy_memory"
  );

  // Web tools = powerful tools with web-search integration
  const webTools = getToolsByCategory("powerful").filter((t) => t.integration === "web-search");

  // Filter initial allowedTools to only KB + web tools (exclude odoo_* and email_*)
  const initialKbTools = agent.allowedTools.filter(
    (id) => !id.startsWith("odoo_") && !id.startsWith("email_")
  );

  const [allowedKbTools, setAllowedKbTools] = useState<string[]>(initialKbTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(grantedDataPaths(agent.pluginConfig));
  const [odooIntegration, setOdooIntegration] = useState<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  } | null>(null);
  const [odooIsDirty, setOdooIsDirty] = useState(false);
  const [emailIntegration, setEmailIntegration] = useState<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  } | null>(null);
  const [emailIsDirty, setEmailIsDirty] = useState(false);
  const [webSearchConfig, setWebSearchConfig] = useState<AgentPluginConfig["pinchy-web"]>(
    agent.pluginConfig?.["pinchy-web"] ?? {}
  );
  // Normalized through getConfirmMap, which reads a pre-#1133 `confirmTools`
  // list when the agent has not been saved since the upgrade. Without that the
  // form would open showing no confirmations on an agent that has them, and
  // saving would then persist that as the truth.
  const [confirm, setConfirm] = useState<ConfirmMap>(() => getConfirmMap(agent.pluginConfig));

  const initialKbToolsRef = useRef(initialKbTools);
  const initialAllowedPaths = useRef(grantedDataPaths(agent.pluginConfig));
  const initialWebSearchConfig = useRef(agent.pluginConfig?.["pinchy-web"] ?? {});
  const initialConfirm = useRef<ConfirmMap>(getConfirmMap(agent.pluginConfig));

  // Re-sync the "initial" snapshot when the agent prop changes (the parent
  // refetches the agent after a successful save, so the prop now reflects the
  // persisted state). Without this the dirty comparison would keep using the
  // mount-time values and falsely report dirty=true the next time a sibling
  // section emits onChange — e.g. Odoo's load effect re-running on a fresh
  // connections reference resets `odooIntegration`, which triggers this
  // component's dirty-recheck against stale refs.
  useEffect(() => {
    initialKbToolsRef.current = agent.allowedTools.filter(
      (id) => !id.startsWith("odoo_") && !id.startsWith("email_")
    );
    initialAllowedPaths.current = grantedDataPaths(agent.pluginConfig);
    initialWebSearchConfig.current = agent.pluginConfig?.["pinchy-web"] ?? {};
    initialConfirm.current = getConfirmMap(agent.pluginConfig);
  }, [agent.allowedTools, agent.pluginConfig]);

  const hasWebToolChecked = webTools.some((tool) => allowedKbTools.includes(tool.id));

  // A reindex operates on the SAVED grants (the route reads pluginConfig), so
  // the reindex section is gated on the persisted paths — never on the picker's
  // unsaved selection, which the server cannot see yet. The parent refetches
  // the agent after a save, so this recomputes to the new truth on its own.
  const savedAllowedPaths = grantedDataPaths(agent.pluginConfig);
  const hasUnsavedPathChanges = !sameDirectorySet(allowedPaths, savedAllowedPaths);

  // Check if the agent has sensitive data access (any allowed paths or odoo/email tools)
  const hasSensitiveDataAccess =
    allowedPaths.length > 0 || odooIntegration !== null || emailIntegration !== null;

  const showSecurityWarning = hasWebToolChecked && hasSensitiveDataAccess;

  // Partition active (non-pending) connections by integration type
  const { odooConnections, emailConnections, webSearchConnections } = useMemo(() => {
    const active = connections.filter((c) => c.status !== "pending");
    return {
      odooConnections: active.filter((c) => c.type === "odoo") as OdooConnection[],
      emailConnections: active.filter((c) => EMAIL_CONNECTION_TYPE_SET.has(c.type)),
      webSearchConnections: active.filter((c) => c.type === "web-search"),
    };
  }, [connections]);

  const showOdoo = odooConnections.length > 0;
  const showEmail = emailConnections.length > 0;
  const hasWebSearchApiKey = webSearchConnections.length > 0;

  // Compute the combined allowedTools array (KB tools + web tools + odoo tools + email tools)
  const computeAllowedTools = useCallback(
    (
      currentKbTools: string[],
      odoo: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null,
      email: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null
    ): string[] => {
      let odooToolIds: string[] = [];
      if (odoo && odoo.permissions.length > 0) {
        const ops = new Set(odoo.permissions.map((p) => p.operation));
        const hasRead = ops.has("read");
        const hasCreate = ops.has("create");
        const hasWrite = ops.has("write");
        const hasDelete = ops.has("delete");

        if (hasDelete && hasCreate && hasWrite && hasRead) {
          odooToolIds = getOdooToolsForAccessLevel("full");
        } else if ((hasCreate || hasWrite) && hasRead) {
          odooToolIds = getOdooToolsForAccessLevel("read-write");
        } else if (hasRead) {
          odooToolIds = getOdooToolsForAccessLevel("read-only");
        } else {
          // Custom: include schema + specific operation tools
          odooToolIds = ["odoo_list_models", "odoo_describe_model"];
          if (hasCreate) odooToolIds.push("odoo_create");
          if (hasWrite) odooToolIds.push("odoo_write");
          if (hasDelete) odooToolIds.push("odoo_delete");
        }
      }

      let emailToolIds: string[] = [];
      if (email && email.permissions.length > 0) {
        emailToolIds = getEmailToolsForOperations(email.permissions.map((p) => p.operation));
      }

      return [...currentKbTools, ...odooToolIds, ...emailToolIds];
    },
    []
  );

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const allAllowedTools = computeAllowedTools(allowedKbTools, odooIntegration, emailIntegration);
    const kbDirty =
      JSON.stringify([...allowedKbTools].sort()) !==
        JSON.stringify([...initialKbToolsRef.current].sort()) ||
      !sameDirectorySet(allowedPaths, initialAllowedPaths.current);
    const webConfigDirty =
      JSON.stringify(webSearchConfig) !== JSON.stringify(initialWebSearchConfig.current);
    const confirmDirty = !sameConfirmMap(confirm, initialConfirm.current);
    const isDirty = kbDirty || odooIsDirty || emailIsDirty || webConfigDirty || confirmDirty;
    // Collect all active integrations
    const integrations: Array<{
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    }> = [];
    if (odooIntegration) integrations.push(odooIntegration);
    if (emailIntegration) integrations.push(emailIntegration);
    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations,
        webSearchConfig,
        confirm: pruneConfirmMap(confirm, allAllowedTools),
      },
      isDirty
    );
  }, [
    allowedKbTools,
    allowedPaths,
    odooIntegration,
    odooIsDirty,
    emailIntegration,
    emailIsDirty,
    webSearchConfig,
    confirm,
    onChange,
    computeAllowedTools,
  ]);

  function handleToolToggle(toolId: string) {
    setAllowedKbTools((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
    );
  }

  function handlePathsChange(newPaths: string[]) {
    setAllowedPaths(newPaths);
  }

  function handleOdooChange(
    values: {
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    } | null,
    isDirty: boolean
  ) {
    setOdooIntegration(values);
    setOdooIsDirty(isDirty);
  }

  function handleEmailChange(
    values: {
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    } | null,
    isDirty: boolean
  ) {
    setEmailIntegration(values);
    setEmailIsDirty(isDirty);
  }

  function handleWebSearchConfigChange(config: AgentPluginConfig["pinchy-web"]) {
    setWebSearchConfig(config);
  }

  const renderToolCheckbox = (tool: { id: string; label: string; description: string }) => (
    <div key={tool.id} className="flex items-center space-x-3">
      <Checkbox
        id={`tool-${tool.id}`}
        checked={allowedKbTools.includes(tool.id)}
        onCheckedChange={() => handleToolToggle(tool.id)}
        aria-label={tool.label}
      />
      <Label htmlFor={`tool-${tool.id}`} className="cursor-pointer">
        <span className="font-medium">{tool.label}</span>
        <span className="text-sm text-muted-foreground ml-2">{tool.description}</span>
      </Label>
    </div>
  );

  return (
    <div className="space-y-8">
      {/* Memory section */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Memory</h3>
        {memoryTools.map(renderToolCheckbox)}
      </section>

      {/* Workspace section — the agent's own drawer */}
      {workspaceTools.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Workspace</h3>
          {workspaceTools.map(renderToolCheckbox)}
        </section>
      )}

      {/* Knowledge Base section: what the agent may read, then how healthy
          the index over it is (#1305). */}
      <section className="space-y-6">
        <h3 className="text-lg font-semibold">Knowledge Base</h3>

        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-medium">Allowed Directories</h4>
            <p className="text-sm text-muted-foreground">
              Agents can read these directories. They can never write to them.
            </p>
          </div>
          <DirectoryPicker
            directories={directories}
            selected={allowedPaths}
            onChange={handlePathsChange}
            label="Allowed Directories"
          />
          {/* Beside the checkboxes that made the change, not in the index
              block below: it is a fact about this form, and only an admin has
              a Reindex button for it to apply to. */}
          {hasUnsavedPathChanges && (
            <UnsavedDirectoriesNotice
              directories={directories}
              saved={savedAllowedPaths}
              selected={allowedPaths}
              isAdmin={isAdmin}
            />
          )}
        </div>

        {/* Admin-only reindex trigger + progress. The async worker/queue is
            server-side (#714); this is the surface to start a run and watch it.
            Gated on isAdmin because the route is admin-only (withAdmin). */}
        {isAdmin && (
          <KnowledgeReindexSection
            agentId={agent.id}
            allowedPathCount={savedAllowedPaths.length}
            hasUnsavedPathChanges={hasUnsavedPathChanges}
            savedPathsKey={savedAllowedPaths.map(directoryKey).sort().join("|")}
          />
        )}

        {/* Explicit KB tool toggles (safe, non-integration) — empty after pinchy_ls/pinchy_read became implicit */}
        {kbTools.length > 0 && <div className="space-y-3">{kbTools.map(renderToolCheckbox)}</div>}
      </section>

      {/* Web Search section — only when at least one active Web Search connection exists */}
      {hasWebSearchApiKey && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Web Search</h3>
          <div className="space-y-3">
            {webTools.map((tool) => (
              <div key={tool.id} className="flex items-center space-x-3">
                <Checkbox
                  id={`tool-${tool.id}`}
                  checked={allowedKbTools.includes(tool.id)}
                  onCheckedChange={() => handleToolToggle(tool.id)}
                  aria-label={tool.label}
                />
                <Label htmlFor={`tool-${tool.id}`} className="cursor-pointer">
                  <span className="font-medium">{tool.label}</span>
                  <span className="text-sm text-muted-foreground ml-2">{tool.description}</span>
                </Label>
              </div>
            ))}
          </div>

          {hasWebToolChecked && (
            <WebSearchPermissionSection
              config={webSearchConfig ?? {}}
              onChange={handleWebSearchConfigChange}
              showSecurityWarning={showSecurityWarning}
            />
          )}
        </section>
      )}

      {/* Odoo section — only when at least one active Odoo connection exists */}
      {showOdoo && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Odoo</h3>
          <OdooPermissionSection
            agentId={agent.id}
            connections={odooConnections}
            onChange={handleOdooChange}
            confirm={confirm}
            onConfirmChange={setConfirm}
          />
        </section>
      )}

      {/* Email section — only when at least one active email-type connection exists */}
      {showEmail && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Email</h3>
          <EmailPermissionSection
            agentId={agent.id}
            connections={emailConnections}
            onChange={handleEmailChange}
          />
        </section>
      )}

      {/* Require confirmation — admin marks which tools pause for the acting
          user to confirm before the agent runs them (#124 Tier 2). */}
      {isAdmin && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Require confirmation before</h3>
          <ApprovalConfirmationSection
            allowedTools={computeAllowedTools(allowedKbTools, odooIntegration, emailIntegration)}
            confirm={confirm}
            onChange={setConfirm}
          />
        </section>
      )}

      {/* Admin-only discoverability link */}
      {isAdmin && (
        <p className="text-sm text-muted-foreground">
          Need more capabilities?{" "}
          <a href="/settings?tab=integrations" className="underline hover:text-foreground">
            Add an integration
          </a>{" "}
          in Settings.
        </p>
      )}
    </div>
  );
}

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * What saving the directory change will do, in terms of the agent — named
 * folders, not "grants". The earlier "a reindex uses the saved grants" was not
 * understood by the product owner (#1305). What it rests on:
 * - search reads the SAVED folders on every query, so a save takes effect at
 *   once in both directions;
 * - the index is shared and nothing is purged, so an untick only takes the
 *   folder out of this agent's answers;
 * - a newly ticked folder is searchable as far as it's already indexed (by
 *   any agent); the rest is added by the next run.
 */
function UnsavedDirectoriesNotice({
  directories,
  saved,
  selected,
  isAdmin,
}: {
  directories: Array<{ path: string; name: string }>;
  saved: string[];
  selected: string[];
  isAdmin: boolean;
}) {
  const nameOf = (path: string) =>
    directories.find((d) => isSameDirectory(d.path, path))?.name ??
    path.replace(/\/+$/, "").split("/").pop() ??
    path;
  const notIn = (list: string[]) => (path: string) => !list.some((p) => isSameDirectory(p, path));
  const added = selected.filter(notIn(saved)).map(nameOf);
  const removed = saved.filter(notIn(selected)).map(nameOf);

  const changes = [
    added.length > 0 ? `starts reading ${listFormat.format(added)}` : null,
    removed.length > 0 ? `stops reading ${listFormat.format(removed)}` : null,
  ].filter(Boolean);

  const sentences = [
    "Not saved yet.",
    changes.length > 0 ? `Once you save, the agent ${changes.join(", and it ")}.` : null,
    added.length > 0 && isAdmin
      ? "Documents there that aren't indexed yet are added by the next reindex."
      : null,
    removed.length > 0
      ? "Documents from folders you untick stay in the index, but no longer show up in this agent's answers."
      : null,
  ].filter(Boolean);

  return (
    // role="status", not Alert's role="alert": a form hint that appears as you
    // tick a box shouldn't interrupt whatever the screen reader is saying.
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{sentences.join(" ")}</p>
    </div>
  );
}
