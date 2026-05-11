"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { DirectoryPicker } from "@/components/directory-picker";
import {
  getToolsByCategory,
  getOdooToolsForAccessLevel,
  getEmailToolsForOperations,
} from "@/lib/tool-registry";
import { isModelVisionCapable } from "@/lib/model-vision";
import { OdooPermissionSection } from "@/components/odoo-permission-section";
import { EmailPermissionSection } from "@/components/email-permission-section";
import { WebSearchPermissionSection } from "@/components/web-search-permission-section";
import type { Connection as OdooConnection } from "@/hooks/use-odoo-permissions";
import type { AgentPluginConfig } from "@/db/schema";

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

const EMAIL_CONNECTION_TYPES = new Set(["google", "microsoft", "imap"]);

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    model: string;
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
  // KB tools = non-integration safe tools only
  const kbTools = getToolsByCategory("safe").filter((t) => !t.integration);

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

  const hasKbToolChecked = kbTools.some((tool) => allowedKbTools.includes(tool.id));
  const hasWebToolChecked = webTools.some((tool) => allowedKbTools.includes(tool.id));

  // Check if the agent has sensitive data access (file tools or odoo tools)
  const hasSensitiveDataAccess =
    allowedKbTools.includes("pinchy_ls") ||
    allowedKbTools.includes("pinchy_read") ||
    odooIntegration !== null ||
    emailIntegration !== null;

  const showSecurityWarning = hasWebToolChecked && hasSensitiveDataAccess;

  // Partition active (non-pending) connections by integration type
  const { odooConnections, emailConnections, webSearchConnections } = useMemo(() => {
    const active = connections.filter((c) => c.status !== "pending");
    return {
      odooConnections: active.filter((c) => c.type === "odoo") as OdooConnection[],
      emailConnections: active.filter((c) => EMAIL_CONNECTION_TYPES.has(c.type)),
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
          odooToolIds = ["odoo_schema"];
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
    const isDirty = kbDirty || odooIsDirty || emailIsDirty || webConfigDirty;
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

  return (
    <div className="space-y-8">
      {/* Knowledge Base section */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Knowledge Base</h3>
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

        {hasKbToolChecked && (
          <div className="ml-6 space-y-2">
            <h4 className="text-sm font-medium">Allowed Directories</h4>
            <DirectoryPicker
              directories={directories}
              selected={allowedPaths}
              onChange={handlePathsChange}
            />
          </div>
        )}

        {allowedKbTools.includes("pinchy_read") && !isModelVisionCapable(agent.model) && (
          <Alert className="ml-6 border-amber-500/50 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-4" />
            <AlertTitle>Limited PDF support</AlertTitle>
            <AlertDescription>
              The selected model doesn&apos;t support vision. Scanned PDFs and embedded images
              won&apos;t be fully readable — only digitally created PDFs with a text layer will
              work.
            </AlertDescription>
          </Alert>
        )}
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
