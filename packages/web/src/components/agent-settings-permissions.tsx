"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DirectoryPicker } from "@/components/directory-picker";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { directoryKey, isSameDirectory, sameDirectorySet } from "@/lib/directory-path";
import {
  getToolsByCategory,
  getOdooToolsForAccessLevel,
  getEmailToolsForOperations,
} from "@/lib/tool-registry";
import { OdooPermissionSection } from "@/components/odoo-permission-section";
import { EmailPermissionSection } from "@/components/email-permission-section";
import { WebSearchPermissionSection } from "@/components/web-search-permission-section";
import { WebSearchNotSetUpNotice } from "@/components/web-search-not-set-up-notice";
import { KnowledgeReindexSection } from "@/components/knowledge-reindex-section";
import { ApprovalConfirmationSection } from "@/components/approval-confirmation-section";
import { getConfirmMap, type ConfirmMap } from "@/lib/approvals/policy";
import type { Connection as OdooConnection } from "@/hooks/use-odoo-permissions";
import type { AgentPluginConfig } from "@/db/schema";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { useGrantedFolders } from "@/hooks/use-granted-folders";

export interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: Array<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  }>;
  webSearchConfig?: AgentPluginConfig["pinchy-web"];
  confirm: ConfirmMap;
  /**
   * False while an Odoo or email section on the page has not reported its
   * grants (still loading, or its load failed). `integrations` then holds only
   * the sections that did load, so it is not the agent's whole grant set: a
   * save must not treat an empty list as "remove every integration" (#1216).
   */
  integrationsLoaded: boolean;
}

type IntegrationGrant = {
  connectionId: string;
  permissions: Array<{ model: string; operation: string }>;
};

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

/** A primitive stand-in for the saved tools with a prefix, stable across refetches. */
function savedToolsKey(allowedTools: string[], prefix: string): string {
  return allowedTools
    .filter((id) => id.startsWith(prefix))
    .sort()
    .join(",");
}

function splitToolsKey(key: string): string[] {
  return key === "" ? [] : key.split(",");
}

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    allowedTools: string[];
    pluginConfig: AgentPluginConfig | null;
  };
  directories: Array<{ path: string; name: string }>;
  /**
   * `null` when the page could not load the connection list. Then it is not
   * known which integration sections belong here, so the agent's saved
   * integration tools stay as they are and the draft reports
   * `integrationsLoaded: false`.
   */
  connections: Connection[] | null;
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
  // `undefined` until the section reports: unknown is not the same as "no
  // access" (null), and only the section's own load can tell them apart.
  const [odooIntegration, setOdooIntegration] = useState<IntegrationGrant | null | undefined>(
    undefined
  );
  const [odooIsDirty, setOdooIsDirty] = useState(false);
  const [emailIntegration, setEmailIntegration] = useState<IntegrationGrant | null | undefined>(
    undefined
  );
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
  // Read from the saved agent, not the form state: unchecking the last web
  // tool must not make the section vanish under the cursor before saving.
  const hasSavedWebTool = webTools.some((tool) => agent.allowedTools.includes(tool.id));

  // A reindex operates on the SAVED grants (the route reads pluginConfig), so
  // the reindex section is gated on the persisted paths — never on the picker's
  // unsaved selection, which the server cannot see yet. The parent refetches
  // the agent after a save, so this recomputes to the new truth on its own.
  const savedAllowedPaths = grantedDataPaths(agent.pluginConfig);
  const hasUnsavedPathChanges = !sameDirectorySet(allowedPaths, savedAllowedPaths);
  const savedPathsKey = savedAllowedPaths.map(directoryKey).sort().join("|");
  // Which saved grants still name a folder that exists (#1363). Admin-only,
  // like the route it reads.
  const grantedFolders = useGrantedFolders(agent.id, savedPathsKey, isAdmin);

  // Partition active (non-pending) connections by integration type
  const { odooConnections, emailConnections, webSearchConnections } = useMemo(() => {
    const active = (connections ?? []).filter((c) => c.status !== "pending");
    return {
      odooConnections: active.filter((c) => c.type === "odoo") as OdooConnection[],
      emailConnections: active.filter((c) => EMAIL_CONNECTION_TYPE_SET.has(c.type)),
      webSearchConnections: active.filter((c) => c.type === "web-search"),
    };
  }, [connections]);

  const showOdoo = odooConnections.length > 0;
  const showEmail = emailConnections.length > 0;
  const hasWebSearchApiKey = webSearchConnections.length > 0;

  // A section that is not on the page has nothing to load: its answer is "no
  // access", as before. A section on the page that has not reported yet keeps
  // the agent's saved tools for that integration, so a save made meanwhile
  // (or after its load failed) leaves those grants exactly as they were.
  // Without a connection list nobody knows which sections belong here, so
  // both count as not reported.
  const connectionsLoaded = connections !== null;
  const odooGrant = !connectionsLoaded ? undefined : showOdoo ? odooIntegration : null;
  const emailGrant = !connectionsLoaded ? undefined : showEmail ? emailIntegration : null;
  // The saved tools stand in only while their section is unreported, and are
  // keyed by content rather than by the agent object: the page refetches the
  // agent after every save, before the sections reload, and a fresh array then
  // would re-emit the form with a section's stale pre-save dirty flag — the
  // Save bar coming back after a save that went through.
  const odooFallbackKey = odooGrant === undefined ? savedToolsKey(agent.allowedTools, "odoo_") : "";
  const emailFallbackKey =
    emailGrant === undefined ? savedToolsKey(agent.allowedTools, "email_") : "";
  const odooFallback = useMemo(() => splitToolsKey(odooFallbackKey), [odooFallbackKey]);
  const emailFallback = useMemo(() => splitToolsKey(emailFallbackKey), [emailFallbackKey]);

  // Check if the agent has sensitive data access (any allowed paths or odoo/email tools)
  const hasSensitiveDataAccess =
    allowedPaths.length > 0 ||
    (odooGrant === undefined ? odooFallback.length > 0 : odooGrant !== null) ||
    (emailGrant === undefined ? emailFallback.length > 0 : emailGrant !== null);

  const showSecurityWarning = hasWebToolChecked && hasSensitiveDataAccess;

  // Compute the combined allowedTools array (KB tools + web tools + odoo tools + email tools)
  const computeAllowedTools = useCallback(
    (
      currentKbTools: string[],
      odoo: IntegrationGrant | null | undefined,
      email: IntegrationGrant | null | undefined
    ): string[] => {
      let odooToolIds: string[] = [];
      if (odoo === undefined) {
        odooToolIds = odooFallback;
      } else if (odoo && odoo.permissions.length > 0) {
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
      if (email === undefined) {
        emailToolIds = emailFallback;
      } else if (email && email.permissions.length > 0) {
        emailToolIds = getEmailToolsForOperations(email.permissions.map((p) => p.operation));
      }

      return [...currentKbTools, ...odooToolIds, ...emailToolIds];
    },
    [odooFallback, emailFallback]
  );

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const allAllowedTools = computeAllowedTools(allowedKbTools, odooGrant, emailGrant);
    const kbDirty =
      JSON.stringify([...allowedKbTools].sort()) !==
        JSON.stringify([...initialKbToolsRef.current].sort()) ||
      !sameDirectorySet(allowedPaths, initialAllowedPaths.current);
    const webConfigDirty =
      JSON.stringify(webSearchConfig) !== JSON.stringify(initialWebSearchConfig.current);
    const confirmDirty = !sameConfirmMap(confirm, initialConfirm.current);
    const isDirty = kbDirty || odooIsDirty || emailIsDirty || webConfigDirty || confirmDirty;
    // Collect all active integrations
    const integrations: IntegrationGrant[] = [];
    if (odooGrant) integrations.push(odooGrant);
    if (emailGrant) integrations.push(emailGrant);
    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations,
        integrationsLoaded: odooGrant !== undefined && emailGrant !== undefined,
        webSearchConfig,
        confirm: pruneConfirmMap(confirm, allAllowedTools),
      },
      isDirty
    );
  }, [
    allowedKbTools,
    allowedPaths,
    odooGrant,
    odooIsDirty,
    emailGrant,
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
              Agents can read these directories and every folder inside them. They can never write
              to them.
            </p>
          </div>
          <DirectoryPicker
            directories={directories}
            selected={allowedPaths}
            onChange={handlePathsChange}
            label="Allowed Directories"
            browseSubfolders={isAdmin}
            grantedFolders={grantedFolders}
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
            savedPathsKey={savedPathsKey}
          />
        )}

        {/* Explicit KB tool toggles (safe, non-integration) — empty after pinchy_ls/pinchy_read became implicit */}
        {kbTools.length > 0 && <div className="space-y-3">{kbTools.map(renderToolCheckbox)}</div>}
      </section>

      {/* Web Search section — when a Web Search connection exists, or when the
          agent already holds a web tool without one (#1297: a web template
          grants both tools regardless; hiding them would make the grant
          invisible and impossible to revoke). */}
      {(hasWebSearchApiKey || hasSavedWebTool) && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Web Search</h3>
          {!hasWebSearchApiKey && <WebSearchNotSetUpNotice />}
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

      {!connectionsLoaded && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            We couldn&apos;t load your integrations, so Odoo and email access can&apos;t be edited
            right now. Whatever this agent has there stays as it is when you save. Refresh the page
            to try again.
          </AlertDescription>
        </Alert>
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
            allowedTools={computeAllowedTools(allowedKbTools, odooGrant, emailGrant)}
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
  // A saved subfolder that a newly ticked parent folds in is gone from the
  // list but not from what the agent reads (#1269), so it is no removal.
  const stillCovered = (path: string) =>
    selected.some((p) => directoryKey(path).startsWith(directoryKey(p) + "/"));
  const removed = saved
    .filter(notIn(selected))
    .filter((path) => !stillCovered(path))
    .map(nameOf);

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
