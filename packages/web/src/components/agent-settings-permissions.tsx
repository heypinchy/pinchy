"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { DirectoryPicker } from "@/components/directory-picker";
import {
  getToolsByCategory,
  getOdooToolsForAccessLevel,
  getPipedriveToolsForAccessLevel,
} from "@/lib/tool-registry";
import { isModelVisionCapable } from "@/lib/model-vision";
import {
  IntegrationPermissionSection,
  type IntegrationPermValues,
} from "@/components/integration-permission-section";
import type {
  IntegrationPermissionsConfig,
  IntegrationConnection,
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

  // Any entities not in any category
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

  // Any entities not in any category
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

// All integration tool prefixes (used to filter them from KB tools)
const INTEGRATION_TOOL_PREFIXES = INTEGRATION_CONFIGS.map((c) => `${c.type}_`);

export interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: Record<
    string,
    { connectionId: string; permissions: Array<{ model: string; operation: string }> }
  > | null;
}

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    model: string;
    allowedTools: string[];
    pluginConfig: { allowed_paths?: string[] } | null;
  };
  directories: Array<{ path: string; name: string }>;
  onChange: (values: PermissionsValues, isDirty: boolean) => void;
}

export function AgentSettingsPermissions({
  agent,
  directories,
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

  // Per-integration state
  const [integrationStates, setIntegrationStates] = useState<
    Record<string, IntegrationPermValues | null>
  >({});
  const [integrationDirtyStates, setIntegrationDirtyStates] = useState<Record<string, boolean>>({});

  // Track which integration types have connections (loaded on mount)
  const [connectionsByType, setConnectionsByType] = useState<
    Record<string, IntegrationConnection[]>
  >({});
  const [connectionsLoading, setConnectionsLoading] = useState(true);

  const initialKbToolsRef = useRef(initialKbTools);
  const initialAllowedPaths = useRef(agent.pluginConfig?.allowed_paths ?? []);

  const hasKbToolChecked = kbTools.some((tool) => allowedKbTools.includes(tool.id));

  // Fetch all connections on mount and group by type
  useEffect(() => {
    async function loadConnections() {
      try {
        const res = await fetch("/api/integrations");
        if (res.ok) {
          const data = (await res.json()) as IntegrationConnection[];
          const grouped: Record<string, IntegrationConnection[]> = {};
          for (const conn of data) {
            if (!grouped[conn.type]) grouped[conn.type] = [];
            grouped[conn.type].push(conn);
          }
          setConnectionsByType(grouped);
        }
      } finally {
        setConnectionsLoading(false);
      }
    }
    loadConnections();
  }, []);

  // Compute the combined allowedTools array (KB tools + integration tools)
  const computeAllowedTools = useCallback(
    (
      currentKbTools: string[],
      intStates: Record<string, IntegrationPermValues | null>
    ): string[] => {
      const allIntegrationToolIds: string[] = [];
      for (const [type, state] of Object.entries(intStates)) {
        if (!state || state.permissions.length === 0) continue;
        const config = INTEGRATION_CONFIGS.find((c) => c.type === type);
        if (config) {
          allIntegrationToolIds.push(...config.getToolsForPermissions(state.permissions));
        }
      }
      return [...currentKbTools, ...allIntegrationToolIds];
    },
    []
  );

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const allAllowedTools = computeAllowedTools(allowedKbTools, integrationStates);
    const kbDirty =
      JSON.stringify([...allowedKbTools].sort()) !==
        JSON.stringify([...initialKbToolsRef.current].sort()) ||
      JSON.stringify([...allowedPaths].sort()) !==
        JSON.stringify([...initialAllowedPaths.current].sort());
    const anyIntegrationDirty = Object.values(integrationDirtyStates).some((d) => d);
    const isDirty = kbDirty || anyIntegrationDirty;

    // Build integrations record: only include types that have a configured state
    const integrationsRecord: Record<
      string,
      { connectionId: string; permissions: Array<{ model: string; operation: string }> }
    > = {};
    let hasAnyIntegration = false;
    for (const [type, state] of Object.entries(integrationStates)) {
      if (state) {
        integrationsRecord[type] = state;
        hasAnyIntegration = true;
      }
    }

    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations: hasAnyIntegration ? integrationsRecord : null,
      },
      isDirty
    );
  }, [
    allowedKbTools,
    allowedPaths,
    integrationStates,
    integrationDirtyStates,
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

  // Determine which integration configs to render (only those with connections)
  const visibleIntegrations = connectionsLoading
    ? []
    : INTEGRATION_CONFIGS.filter((config) => (connectionsByType[config.type]?.length ?? 0) > 0);

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

      {/* Integration sections — rendered dynamically based on available connections */}
      {visibleIntegrations.map((config) => (
        <section key={config.type} className="space-y-4">
          <h3 className="text-lg font-semibold">{config.label}</h3>
          <IntegrationPermissionSection
            agentId={agent.id}
            integrationType={config.type}
            label={config.label}
            entityLabel={config.entityLabel}
            entityLabelSingular={config.entityLabelSingular}
            connections={connectionsByType[config.type] ?? []}
            hookConfig={config.hookConfig}
            operations={config.operations}
            operationLabels={config.operationLabels}
            categorizeEntities={config.categorizeEntities}
            restrictionTooltip={config.restrictionTooltip}
            onChange={handleIntegrationChange(config.type)}
          />
        </section>
      ))}
    </div>
  );
}
