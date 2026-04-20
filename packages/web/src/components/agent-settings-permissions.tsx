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
  getPipedriveToolsForAccessLevel,
  getEmailToolsForOperations,
} from "@/lib/tool-registry";
import { isModelVisionCapable } from "@/lib/model-vision";
import {
  IntegrationPermissionSection,
  type IntegrationPermValues,
} from "@/components/integration-permission-section";
import { EmailPermissionSection } from "@/components/email-permission-section";
import type {
  IntegrationPermissionsConfig,
  IntegrationEntity,
} from "@/hooks/use-integration-permissions";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-sync";
import { ENTITY_CATEGORIES } from "@/lib/integrations/pipedrive-sync";

// --- Integration type configurations ---

const ODOO_INTEGRATION_CONFIG: IntegrationPermissionsConfig = {
  type: "odoo",
  operations: ["read", "create", "write", "delete"],
  getEntitiesFromData: (data) => {
    const d = data as {
      models?: Array<{ model: string; name: string; access?: Record<string, boolean> }>;
    };
    return (d?.models ?? []).map((m) => ({ id: m.model, name: m.name, access: m.access }));
  },
};

const PIPEDRIVE_INTEGRATION_CONFIG: IntegrationPermissionsConfig = {
  type: "pipedrive",
  operations: ["read", "create", "update", "delete"],
  getEntitiesFromData: (data) => {
    const d = data as {
      entities?: Array<{
        entity: string;
        name: string;
        operations?: Record<string, boolean>;
      }>;
    };
    return (d?.entities ?? []).map((e) => ({
      id: e.entity,
      name: e.name,
      access: e.operations,
    }));
  },
};

/** Group Odoo models by their MODEL_CATEGORIES category. Uncategorized models go into "Other". */
function categorizeOdooEntities(
  entities: IntegrationEntity[]
): Array<{ label: string; entities: IntegrationEntity[] }> {
  const entitySet = new Set(entities.map((e) => e.id));
  const groups: Array<{ label: string; entities: IntegrationEntity[] }> = [];

  for (const cat of MODEL_CATEGORIES) {
    const catEntities = cat.models
      .filter((m) => entitySet.has(m.model))
      .map((m) => entities.find((e) => e.id === m.model)!)
      .filter(Boolean);
    if (catEntities.length > 0) {
      groups.push({ label: cat.label, entities: catEntities });
    }
  }

  const categorized = new Set(MODEL_CATEGORIES.flatMap((c) => c.models.map((m) => m.model)));
  const uncategorized = entities.filter((e) => !categorized.has(e.id));
  if (uncategorized.length > 0) {
    groups.push({ label: "Other", entities: uncategorized });
  }

  return groups;
}

/** Group Pipedrive entities by their ENTITY_CATEGORIES category. */
function categorizePipedriveEntities(
  entities: IntegrationEntity[]
): Array<{ label: string; entities: IntegrationEntity[] }> {
  const entitySet = new Set(entities.map((e) => e.id));
  const groups: Array<{ label: string; entities: IntegrationEntity[] }> = [];

  for (const cat of ENTITY_CATEGORIES) {
    const catEntities = cat.entities
      .filter((ce) => entitySet.has(ce.entity))
      .map((ce) => entities.find((e) => e.id === ce.entity)!)
      .filter(Boolean);
    if (catEntities.length > 0) {
      groups.push({ label: cat.label, entities: catEntities });
    }
  }

  const categorized = new Set(ENTITY_CATEGORIES.flatMap((c) => c.entities.map((e) => e.entity)));
  const uncategorized = entities.filter((e) => !categorized.has(e.id));
  if (uncategorized.length > 0) {
    groups.push({ label: "Other", entities: uncategorized });
  }

  return groups;
}

function computeOdooTools(permissions: Array<{ model: string; operation: string }>): string[] {
  const ops = new Set(permissions.map((p) => p.operation));
  const hasRead = ops.has("read");
  const hasCreate = ops.has("create");
  const hasWrite = ops.has("write");
  const hasDelete = ops.has("delete");

  if (hasDelete && hasCreate && hasWrite && hasRead) {
    return getOdooToolsForAccessLevel("full");
  } else if ((hasCreate || hasWrite) && hasRead) {
    return getOdooToolsForAccessLevel("read-write");
  } else if (hasRead) {
    return getOdooToolsForAccessLevel("read-only");
  } else {
    const tools = ["odoo_schema"];
    if (hasCreate) tools.push("odoo_create");
    if (hasWrite) tools.push("odoo_write");
    if (hasDelete) tools.push("odoo_delete");
    return tools;
  }
}

function computePipedriveTools(permissions: Array<{ model: string; operation: string }>): string[] {
  const ops = new Set(permissions.map((p) => p.operation));
  const hasRead = ops.has("read");
  const hasCreate = ops.has("create");
  const hasUpdate = ops.has("update");
  const hasDelete = ops.has("delete");

  if (hasDelete && hasCreate && hasUpdate && hasRead) {
    return getPipedriveToolsForAccessLevel("full");
  } else if ((hasCreate || hasUpdate) && hasRead) {
    return getPipedriveToolsForAccessLevel("read-write");
  } else if (hasRead) {
    return getPipedriveToolsForAccessLevel("read-only");
  } else {
    const tools = ["pipedrive_schema"];
    if (hasCreate) tools.push("pipedrive_create");
    if (hasUpdate) tools.push("pipedrive_update");
    if (hasDelete) tools.push("pipedrive_delete", "pipedrive_merge");
    return tools;
  }
}

interface IntegrationTypeConfig {
  type: string;
  label: string;
  entityLabel: string;
  entityLabelSingular: string;
  operations: readonly string[];
  operationLabels: Record<string, string>;
  hookConfig: IntegrationPermissionsConfig;
  categorizeEntities: (
    entities: IntegrationEntity[]
  ) => Array<{ label: string; entities: IntegrationEntity[] }>;
  restrictionTooltip: string;
  getToolsForPermissions: (permissions: Array<{ model: string; operation: string }>) => string[];
}

const INTEGRATION_CONFIGS: IntegrationTypeConfig[] = [
  {
    type: "odoo",
    label: "Odoo",
    entityLabel: "Models",
    entityLabelSingular: "Model",
    operations: ["read", "create", "write", "delete"],
    operationLabels: { read: "Read", create: "Create", write: "Write", delete: "Delete" },
    hookConfig: ODOO_INTEGRATION_CONFIG,
    categorizeEntities: categorizeOdooEntities,
    restrictionTooltip: "Not available — Odoo user lacks this permission",
    getToolsForPermissions: computeOdooTools,
  },
  {
    type: "pipedrive",
    label: "Pipedrive",
    entityLabel: "Entities",
    entityLabelSingular: "Entity",
    operations: ["read", "create", "update", "delete"],
    operationLabels: { read: "Read", create: "Create", update: "Update", delete: "Delete" },
    hookConfig: PIPEDRIVE_INTEGRATION_CONFIG,
    categorizeEntities: categorizePipedriveEntities,
    restrictionTooltip: "Not available — limited by your Pipedrive plan",
    getToolsForPermissions: computePipedriveTools,
  },
];

// Integration tool prefixes that are managed by generic + email sections — filtered out of KB tools.
const INTEGRATION_TOOL_PREFIXES = [...INTEGRATION_CONFIGS.map((c) => `${c.type}_`), "email_"];

export interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: Array<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  }>;
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
    pluginConfig: { allowed_paths?: string[] } | null;
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

  // Filter initial allowedTools to only KB tools (exclude all integration prefixes)
  const initialKbTools = agent.allowedTools.filter(
    (id) => !INTEGRATION_TOOL_PREFIXES.some((prefix) => id.startsWith(prefix))
  );

  const [allowedKbTools, setAllowedKbTools] = useState<string[]>(initialKbTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(
    agent.pluginConfig?.allowed_paths ?? []
  );

  // Per-integration state for generic-backed types (odoo, pipedrive)
  const [integrationStates, setIntegrationStates] = useState<
    Record<string, IntegrationPermValues | null>
  >({});
  const [integrationDirtyStates, setIntegrationDirtyStates] = useState<Record<string, boolean>>({});

  // Dedicated email state (email has a different UX model than the generic section)
  const [emailIntegration, setEmailIntegration] = useState<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  } | null>(null);
  const [emailIsDirty, setEmailIsDirty] = useState(false);

  const initialKbToolsRef = useRef(initialKbTools);
  const initialAllowedPaths = useRef(agent.pluginConfig?.allowed_paths ?? []);

  const hasKbToolChecked = kbTools.some((tool) => allowedKbTools.includes(tool.id));

  // Partition active (non-pending) connections by integration family
  const { connectionsByType, emailConnections } = useMemo(() => {
    const active = connections.filter((c) => c.status !== "pending");
    const byType: Record<string, Connection[]> = {};
    for (const conn of active) {
      if (!byType[conn.type]) byType[conn.type] = [];
      byType[conn.type].push(conn);
    }
    const emails = active.filter((c) => EMAIL_CONNECTION_TYPES.has(c.type));
    return { connectionsByType: byType, emailConnections: emails };
  }, [connections]);

  // Compute the combined allowedTools array (KB tools + generic integration tools + email tools)
  const computeAllowedTools = useCallback(
    (
      currentKbTools: string[],
      intStates: Record<string, IntegrationPermValues | null>,
      email: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null
    ): string[] => {
      const allIntegrationToolIds: string[] = [];
      for (const [type, state] of Object.entries(intStates)) {
        if (!state || state.permissions.length === 0) continue;
        const config = INTEGRATION_CONFIGS.find((c) => c.type === type);
        if (config) {
          allIntegrationToolIds.push(...config.getToolsForPermissions(state.permissions));
        }
      }
      const emailToolIds =
        email && email.permissions.length > 0
          ? getEmailToolsForOperations(email.permissions.map((p) => p.operation))
          : [];
      return [...currentKbTools, ...allIntegrationToolIds, ...emailToolIds];
    },
    []
  );

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const allAllowedTools = computeAllowedTools(
      allowedKbTools,
      integrationStates,
      emailIntegration
    );
    const kbDirty =
      JSON.stringify([...allowedKbTools].sort()) !==
        JSON.stringify([...initialKbToolsRef.current].sort()) ||
      JSON.stringify([...allowedPaths].sort()) !==
        JSON.stringify([...initialAllowedPaths.current].sort());
    const anyIntegrationDirty = Object.values(integrationDirtyStates).some((d) => d);
    const isDirty = kbDirty || anyIntegrationDirty || emailIsDirty;

    const integrations: Array<{
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    }> = [];
    for (const state of Object.values(integrationStates)) {
      if (state) integrations.push(state);
    }
    if (emailIntegration) integrations.push(emailIntegration);

    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations,
      },
      isDirty
    );
  }, [
    allowedKbTools,
    allowedPaths,
    integrationStates,
    integrationDirtyStates,
    emailIntegration,
    emailIsDirty,
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

  function handleIntegrationChange(type: string) {
    return (values: IntegrationPermValues | null, isDirty: boolean) => {
      setIntegrationStates((prev) => ({ ...prev, [type]: values }));
      setIntegrationDirtyStates((prev) => ({ ...prev, [type]: isDirty }));
    };
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

  // Render only integration types that have at least one active connection
  const visibleIntegrations = INTEGRATION_CONFIGS.filter(
    (config) => (connectionsByType[config.type]?.length ?? 0) > 0
  );
  const showEmail = emailConnections.length > 0;

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

      {/* Generic integration sections (Odoo, Pipedrive) */}
      {visibleIntegrations.map((config) => (
        <section key={config.type} className="space-y-4">
          <h3 className="text-lg font-semibold">{config.label}</h3>
          <IntegrationPermissionSection
            agentId={agent.id}
            integrationType={config.type}
            label={config.label}
            entityLabel={config.entityLabel}
            entityLabelSingular={config.entityLabelSingular}
            connections={(connectionsByType[config.type] ?? []).map((c) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              data: c.data,
            }))}
            hookConfig={config.hookConfig}
            operations={config.operations}
            operationLabels={config.operationLabels}
            categorizeEntities={config.categorizeEntities}
            restrictionTooltip={config.restrictionTooltip}
            onChange={handleIntegrationChange(config.type)}
          />
        </section>
      ))}

      {/* Email section — dedicated UX (single model, 3 operations) */}
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
