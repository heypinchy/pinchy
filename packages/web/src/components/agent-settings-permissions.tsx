"use client";

import { useState, useRef, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DirectoryPicker } from "@/components/directory-picker";
import { getToolsByCategory } from "@/lib/tool-registry";

interface AgentSettingsPermissionsProps {
  agent: {
    id: string;
    allowedTools: string[];
    pluginConfig: { allowed_paths?: string[] } | null;
  };
  directories: Array<{ path: string; name: string }>;
  onChange: (values: { allowedTools: string[]; allowedPaths: string[] }, isDirty: boolean) => void;
}

export function AgentSettingsPermissions({
  agent,
  directories,
  onChange,
}: AgentSettingsPermissionsProps) {
  const [allowedTools, setAllowedTools] = useState<string[]>(agent.allowedTools);
  const [allowedPaths, setAllowedPaths] = useState<string[]>(
    agent.pluginConfig?.allowed_paths ?? []
  );

  const initialAllowedTools = useRef(agent.allowedTools);
  const initialAllowedPaths = useRef(agent.pluginConfig?.allowed_paths ?? []);

  const safeTools = getToolsByCategory("safe");
  const powerfulTools = getToolsByCategory("powerful");

  const hasSafeToolChecked = safeTools.some((tool) => allowedTools.includes(tool.id));

  // Notify parent after every state change (and on mount)
  useEffect(() => {
    const isDirty =
      JSON.stringify([...allowedTools].sort()) !==
        JSON.stringify([...initialAllowedTools.current].sort()) ||
      JSON.stringify([...allowedPaths].sort()) !==
        JSON.stringify([...initialAllowedPaths.current].sort());
    onChange({ allowedTools, allowedPaths }, isDirty);
  }, [allowedTools, allowedPaths, onChange]);

  function handleToolToggle(toolId: string) {
    setAllowedTools((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
    );
  }

  function handlePathsChange(newPaths: string[]) {
    setAllowedPaths(newPaths);
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
              onChange={handlePathsChange}
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
    </div>
  );
}
