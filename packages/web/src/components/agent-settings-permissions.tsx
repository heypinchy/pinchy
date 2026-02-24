"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DirectoryPicker } from "@/components/directory-picker";
import { getToolsByCategory } from "@/lib/tool-registry";
import { useRestart } from "@/components/restart-provider";

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    allowedTools: string[];
    pluginConfig: { allowed_paths?: string[] } | null;
  };
  directories: Array<{ path: string; name: string }>;
}

export function AgentSettingsPermissions({ agent, directories }: AgentSettingsPermissionsProps) {
  const [allowedTools, setAllowedTools] = useState<string[]>(agent.allowedTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(
    agent.pluginConfig?.allowed_paths ?? []
  );
  const [saving, setSaving] = useState(false);
  const { triggerRestart } = useRestart();

  const safeTools = getToolsByCategory("safe");
  const powerfulTools = getToolsByCategory("powerful");

  const hasSafeToolChecked = safeTools.some((tool) => allowedTools.includes(tool.id));

  function handleToolToggle(toolId: string) {
    setAllowedTools((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedTools,
          pluginConfig: { allowed_paths: allowedPaths },
        }),
      });

      if (!res.ok) {
        toast.error("Failed to save permissions");
        return;
      }

      toast.success("Permissions saved");
      triggerRestart();
    } catch {
      toast.error("Failed to save permissions");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Safe Tools</h3>
        <div className="space-y-3">
          {safeTools.map((tool) => (
            <div key={tool.id} className="flex items-center space-x-3">
              <Checkbox
                id={`tool-${tool.id}`}
                checked={allowedTools.includes(tool.id)}
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

        {hasSafeToolChecked && (
          <div className="ml-6 space-y-2">
            <h4 className="text-sm font-medium">Allowed Directories</h4>
            <DirectoryPicker
              directories={directories}
              selected={allowedPaths}
              onChange={setAllowedPaths}
            />
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Powerful Tools</h3>
        <p className="text-sm text-amber-600 dark:text-amber-400">
          These tools give the agent direct access to your server. Only enable them if you
          understand the risks.
        </p>
        <div className="space-y-3">
          {powerfulTools.map((tool) => (
            <div key={tool.id} className="flex items-center space-x-3">
              <Checkbox
                id={`tool-${tool.id}`}
                checked={allowedTools.includes(tool.id)}
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
      </section>

      <div className="space-y-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save & restart"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Saving will briefly disconnect all active chats while the agent runtime restarts.
        </p>
      </div>
    </div>
  );
}
