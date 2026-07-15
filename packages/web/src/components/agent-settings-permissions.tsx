"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DirectoryPicker } from "@/components/directory-picker";
import {
  getToolsByCategory,
  getOdooToolsForAccessLevel,
  getEmailToolsForOperations,
} from "@/lib/tool-registry";
import { OdooPermissionSection } from "@/components/odoo-permission-section";
import { EmailPermissionSection } from "@/components/email-permission-section";
import { WebSearchPermissionSection } from "@/components/web-search-permission-section";
import {
  McpPermissionSection,
  type McpIntegrationValue,
} from "@/components/mcp-permission-section";
import type { Connection as OdooConnection } from "@/hooks/use-odoo-permissions";
import type { AgentPluginConfig } from "@/db/schema";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";

export interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: Array<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  }>;
  webSearchConfig?: AgentPluginConfig["pinchy-web"];
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
  /**
   * Server-gated MCP feature flag (PINCHY_MCP_ENABLED), threaded down as a
   * prop from the settings page's server component — never read from a
   * NEXT_PUBLIC_ env var or process.env directly in this "use client" tree.
   * Defaults to false (fail closed) so existing callers that don't pass it
   * keep the MCP section hidden.
   */
  mcpEnabled?: boolean;
  onChange: (values: PermissionsValues, isDirty: boolean) => void;
}

export function AgentSettingsPermissions({
  agent,
  directories,
  connections,
  isAdmin,
  mcpEnabled = false,
  onChange,
}: AgentSettingsPermissionsProps) {
  // KB tools: non-integration safe tools (pinchy_ls / pinchy_read are now implicit — not shown)
  const kbTools = getToolsByCategory("safe").filter((t) => !t.integration);

  // Powerful tools shown in the KB section: non-integration powerful tools (e.g. pinchy_write)
  const powerfulKbTools = getToolsByCategory("powerful").filter((t) => !t.integration);

  // Web tools = powerful tools with web-search integration
  const webTools = getToolsByCategory("powerful").filter((t) => t.integration === "web-search");

  // Filter initial allowedTools to only KB + web tools (exclude odoo_* and email_*)
  const initialKbTools = agent.allowedTools.filter(
    (id) => !id.startsWith("odoo_") && !id.startsWith("email_")
  );

  const [allowedKbTools, setAllowedKbTools] = useState<string[]>(initialKbTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(
    agent.pluginConfig?.["pinchy-files"]?.allowed_paths ?? []
  );
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
  // MCP supports several simultaneous connections (unlike Odoo/Email's
  // single-connection dropdown), so its section reports a whole ARRAY of
  // integration entries rather than at most one — see
  // mcp-permission-section.tsx for why an entry can carry an empty
  // `permissions` array (explicit revoke-to-zero for one connection while
  // others are untouched).
  const [mcpIntegrations, setMcpIntegrations] = useState<McpIntegrationValue[]>([]);
  const [mcpIsDirty, setMcpIsDirty] = useState(false);
  const [webSearchConfig, setWebSearchConfig] = useState<AgentPluginConfig["pinchy-web"]>(
    agent.pluginConfig?.["pinchy-web"] ?? {}
  );

  const initialKbToolsRef = useRef(initialKbTools);
  const initialAllowedPaths = useRef(agent.pluginConfig?.["pinchy-files"]?.allowed_paths ?? []);
  const initialWebSearchConfig = useRef(agent.pluginConfig?.["pinchy-web"] ?? {});

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
    initialAllowedPaths.current = agent.pluginConfig?.["pinchy-files"]?.allowed_paths ?? [];
    initialWebSearchConfig.current = agent.pluginConfig?.["pinchy-web"] ?? {};
  }, [agent.allowedTools, agent.pluginConfig]);

  const hasWebToolChecked = webTools.some((tool) => allowedKbTools.includes(tool.id));

  // Check if the agent has sensitive data access (any allowed paths or odoo/email tools)
  const hasSensitiveDataAccess =
    allowedPaths.length > 0 || odooIntegration !== null || emailIntegration !== null;

  const showSecurityWarning = hasWebToolChecked && hasSensitiveDataAccess;

  // Partition active (non-pending) connections by integration type
  const { odooConnections, emailConnections, webSearchConnections, mcpConnections } =
    useMemo(() => {
      const active = connections.filter((c) => c.status !== "pending");
      return {
        odooConnections: active.filter((c) => c.type === "odoo") as OdooConnection[],
        emailConnections: active.filter((c) => EMAIL_CONNECTION_TYPE_SET.has(c.type)),
        webSearchConnections: active.filter((c) => c.type === "web-search"),
        // MCP is stricter than "not pending": build.ts (T6) only emits
        // mcp.servers/tools.allow for connections whose status is exactly
        // "active", NOT "auth_failed" (unlike Odoo/Email, whose gating is a
        // runtime plugin check, not baked into config). Showing the grant UI
        // for an auth_failed connection would let an admin check tools that
        // silently do nothing until the connection recovers — so this section
        // mirrors build.ts's own filter instead of reusing "not pending".
        mcpConnections: active.filter((c) => c.type === "mcp" && c.status === "active"),
      };
    }, [connections]);

  const showOdoo = odooConnections.length > 0;
  const showEmail = emailConnections.length > 0;
  const hasWebSearchApiKey = webSearchConnections.length > 0;
  const showMcp = mcpEnabled && mcpConnections.length > 0;

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
      JSON.stringify([...allowedPaths].sort()) !==
        JSON.stringify([...initialAllowedPaths.current].sort());
    const webConfigDirty =
      JSON.stringify(webSearchConfig) !== JSON.stringify(initialWebSearchConfig.current);
    const isDirty = kbDirty || odooIsDirty || emailIsDirty || webConfigDirty || mcpIsDirty;
    // Collect all active integrations
    const integrations: Array<{
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    }> = [];
    if (odooIntegration) integrations.push(odooIntegration);
    if (emailIntegration) integrations.push(emailIntegration);
    // MCP tools are NOT part of allowedTools (they don't map to static tool
    // IDs the way odoo_*/email_* do) — build.ts derives tools.allow directly
    // from agent_connection_permissions where model="mcp" (T6). This section
    // only needs to contribute its permission rows to the generic
    // integrations array so the existing save flow PUTs them.
    integrations.push(...mcpIntegrations);
    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations,
        webSearchConfig,
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
    mcpIntegrations,
    mcpIsDirty,
    webSearchConfig,
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

  function handleMcpChange(values: McpIntegrationValue[], isDirty: boolean) {
    setMcpIntegrations(values);
    setMcpIsDirty(isDirty);
  }

  function handleWebSearchConfigChange(config: AgentPluginConfig["pinchy-web"]) {
    setWebSearchConfig(config);
  }

  return (
    <div className="space-y-8">
      {/* Knowledge Base section */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Knowledge Base</h3>

        {/* Directory picker — always shown when directories are available */}
        {directories.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Allowed Directories</h4>
            <DirectoryPicker
              directories={directories}
              selected={allowedPaths}
              onChange={handlePathsChange}
            />
          </div>
        )}

        {/* Explicit KB tool toggles (safe, non-integration) — empty after pinchy_ls/pinchy_read became implicit */}
        {kbTools.length > 0 && (
          <div className="space-y-3">
            {kbTools.map((tool) => (
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
        )}

        {/* Powerful non-integration tools (e.g. pinchy_write) */}
        {powerfulKbTools.map((tool) => (
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

      {/* MCP section — flag-gated, only when at least one active MCP connection exists */}
      {showMcp && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">MCP</h3>
          <McpPermissionSection
            agentId={agent.id}
            connections={mcpConnections}
            onChange={handleMcpChange}
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
