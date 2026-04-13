"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { DirectoryPicker } from "@/components/directory-picker";
import { getToolsByCategory, getOdooToolsForAccessLevel } from "@/lib/tool-registry";
import { isModelVisionCapable } from "@/lib/model-vision";
import { OdooPermissionSection } from "@/components/odoo-permission-section";

interface PermissionsValues {
  allowedTools: string[];
  allowedPaths: string[];
  integrations: {
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  } | null;
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

  // Filter initial allowedTools to only KB tools (exclude odoo_*)
  const initialKbTools = agent.allowedTools.filter((id) => !id.startsWith("odoo_"));

  const [allowedKbTools, setAllowedKbTools] = useState<string[]>(initialKbTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(
    agent.pluginConfig?.allowed_paths ?? []
  );
  const [odooIntegration, setOdooIntegration] = useState<{
    connectionId: string;
    permissions: Array<{ model: string; operation: string }>;
  } | null>(null);
  const [odooIsDirty, setOdooIsDirty] = useState(false);

  const initialKbToolsRef = useRef(initialKbTools);
  const initialAllowedPaths = useRef(agent.pluginConfig?.allowed_paths ?? []);

  const hasKbToolChecked = kbTools.some((tool) => allowedKbTools.includes(tool.id));

  // Compute the combined allowedTools array (KB tools + odoo tools based on integration)
  const computeAllowedTools = useCallback(
    (
      currentKbTools: string[],
      integration: {
        connectionId: string;
        permissions: Array<{ model: string; operation: string }>;
      } | null
    ): string[] => {
      let odooToolIds: string[] = [];
      if (integration && integration.permissions.length > 0) {
        const ops = new Set(integration.permissions.map((p) => p.operation));
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
      return [...currentKbTools, ...odooToolIds];
    },
    []
  );

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const allAllowedTools = computeAllowedTools(allowedKbTools, odooIntegration);
    const kbDirty =
      JSON.stringify([...allowedKbTools].sort()) !==
        JSON.stringify([...initialKbToolsRef.current].sort()) ||
      JSON.stringify([...allowedPaths].sort()) !==
        JSON.stringify([...initialAllowedPaths.current].sort());
    const isDirty = kbDirty || odooIsDirty;
    onChange(
      {
        allowedTools: allAllowedTools,
        allowedPaths,
        integrations: odooIntegration,
      },
      isDirty
    );
  }, [allowedKbTools, allowedPaths, odooIntegration, odooIsDirty, onChange, computeAllowedTools]);

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

      {/* Odoo section */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Odoo</h3>
        <OdooPermissionSection agentId={agent.id} onChange={handleOdooChange} />
      </section>
    </div>
  );
}
