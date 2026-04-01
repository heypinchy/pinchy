"use client";

import { useEffect, useRef, useState } from "react";
import { X, Plus, ChevronsUpDown } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useOdooPermissions, type Operation, type OdooModel } from "@/hooks/use-odoo-permissions";
import type { OdooAccessLevel } from "@/lib/tool-registry";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-sync";

const OPERATIONS: readonly Operation[] = ["read", "create", "write", "delete"];

const ACCESS_LEVEL_OPTIONS: { value: OdooAccessLevel; label: string }[] = [
  { value: "read-only", label: "Read-only" },
  { value: "read-write", label: "Read & Write" },
  { value: "full", label: "Full" },
  { value: "custom", label: "Custom" },
];

/** Group models by their MODEL_CATEGORIES category. Uncategorized models go into "Other". */
function groupModelsByCategory(models: OdooModel[]): Array<{ label: string; models: OdooModel[] }> {
  const modelSet = new Set(models.map((m) => m.model));
  const groups: Array<{ label: string; models: OdooModel[] }> = [];

  for (const cat of MODEL_CATEGORIES) {
    const catModels = cat.models
      .filter((m) => modelSet.has(m.model))
      .map((m) => models.find((am) => am.model === m.model)!)
      .filter(Boolean);
    if (catModels.length > 0) {
      groups.push({ label: cat.label, models: catModels });
    }
  }

  // Any models not in any category
  const categorized = new Set(MODEL_CATEGORIES.flatMap((c) => c.models.map((m) => m.model)));
  const uncategorized = models.filter((m) => !categorized.has(m.model));
  if (uncategorized.length > 0) {
    groups.push({ label: "Other", models: uncategorized });
  }

  return groups;
}

interface OdooPermissionSectionProps {
  agentId: string;
  onChange: (
    values: {
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    } | null,
    isDirty: boolean
  ) => void;
}

export function OdooPermissionSection({ agentId, onChange }: OdooPermissionSectionProps) {
  const {
    connections,
    connectionId,
    accessLevel,
    addedModels,
    availableModels,
    loading,
    setConnectionId,
    setAccessLevel,
    addModel,
    addAllModels,
    removeModel,
    toggleOperation,
    getModelAccess,
    getPermissions,
    isDirty,
  } = useOdooPermissions(agentId);

  const [addModelOpen, setAddModelOpen] = useState(false);

  // Stable ref for onChange to avoid infinite re-render loops
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Notify parent of changes
  // Connection without models = not configured → report null
  useEffect(() => {
    if (loading) return;
    const perms = getPermissions();
    const hasConfig = connectionId && perms.length > 0;
    onChangeRef.current(hasConfig ? { connectionId, permissions: perms } : null, isDirty);
  }, [connectionId, addedModels, loading, getPermissions, isDirty]);

  if (loading) {
    return <div className="text-muted-foreground py-4">Loading Odoo configuration...</div>;
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-muted-foreground">No Odoo connections configured.</p>
        <p className="text-sm text-muted-foreground">
          Go to{" "}
          <a href="/settings?tab=integrations" className="underline hover:text-foreground">
            Settings &gt; Integrations
          </a>{" "}
          to add a connection first.
        </p>
      </div>
    );
  }

  // Get the selected connection to check for synced models
  const selectedConnection = connections.find((c) => c.id === connectionId);
  const hasModels = selectedConnection?.data?.models
    ? selectedConnection.data.models.length > 0
    : false;

  return (
    <div className="space-y-6">
      {/* Connection selector */}
      <div className="space-y-2">
        <Label>Connection</Label>
        <div className="flex items-center gap-2">
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Select a connection..." />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connectionId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => setConnectionId("")}
              aria-label="Clear connection"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Only show access level + models when a connection is selected */}
      {connectionId && (
        <>
          {/* Access level */}
          <div className="space-y-3">
            <Label>Access</Label>
            <RadioGroup
              value={accessLevel}
              onValueChange={(v) => setAccessLevel(v as OdooAccessLevel)}
              className="flex flex-wrap gap-4"
            >
              {ACCESS_LEVEL_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-center gap-2">
                  <RadioGroupItem value={opt.value} id={`access-${opt.value}`} />
                  <Label htmlFor={`access-${opt.value}`} className="cursor-pointer font-normal">
                    {opt.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* No models synced warning */}
          {!hasModels && (
            <p className="text-sm text-muted-foreground">
              No models available. Sync the connection schema in Settings &gt; Integrations first.
            </p>
          )}

          {/* Models section */}
          {hasModels && (
            <div className="space-y-4">
              <Label>Models</Label>

              {/* Model table */}
              {addedModels.size > 0 && (
                <div className="rounded-md border">
                  {/* Header */}
                  <div className="grid grid-cols-[1fr_60px_60px_60px_60px_40px] gap-2 border-b px-4 py-2 text-sm font-medium text-muted-foreground">
                    <span>Model</span>
                    <span className="text-center">Read</span>
                    <span className="text-center">Create</span>
                    <span className="text-center">Write</span>
                    <span className="text-center">Delete</span>
                    <span />
                  </div>

                  {/* Rows */}
                  <div className="max-h-[400px] overflow-y-auto">
                    {Array.from(addedModels.entries()).map(([modelId, ops]) => {
                      // Look up display name and category from connection models
                      const modelInfo = selectedConnection?.data?.models?.find(
                        (m) => m.model === modelId
                      );
                      const displayName = modelInfo?.name ?? modelId;
                      const category = MODEL_CATEGORIES.find((c) =>
                        c.models.some((m) => m.model === modelId)
                      );
                      const modelAccess = getModelAccess(modelId);

                      return (
                        <div
                          key={modelId}
                          className="grid grid-cols-[1fr_60px_60px_60px_60px_40px] gap-2 border-b px-4 py-2 last:border-b-0 items-center"
                        >
                          <div>
                            <div className="text-sm font-medium">
                              {category && (
                                <span className="text-muted-foreground font-normal">
                                  {category.label}:{" "}
                                </span>
                              )}
                              {displayName}
                            </div>
                            <div className="text-xs text-muted-foreground">{modelId}</div>
                          </div>
                          {OPERATIONS.map((op) => {
                            const restricted = !modelAccess[op];
                            const checkbox = (
                              <Checkbox
                                checked={ops[op]}
                                onCheckedChange={() => toggleOperation(modelId, op)}
                                disabled={restricted}
                                aria-label={`${op} ${displayName}`}
                              />
                            );

                            return (
                              <div key={op} className="flex justify-center">
                                {restricted ? (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span>{checkbox}</span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        Not available — Odoo user lacks this permission
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  checkbox
                                )}
                              </div>
                            );
                          })}
                          <div className="flex justify-center">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => removeModel(modelId)}
                              aria-label={`Remove ${displayName}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Add model controls */}
              <div className="flex items-center gap-2">
                <Popover open={addModelOpen} onOpenChange={setAddModelOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" disabled={availableModels.length === 0}>
                      <Plus className="mr-1 h-4 w-4" />
                      Add model...
                      <ChevronsUpDown className="ml-1 h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search models..." />
                      <CommandList>
                        <CommandEmpty>No models found.</CommandEmpty>
                        {groupModelsByCategory(availableModels).map(({ label, models }) => (
                          <CommandGroup
                            key={label}
                            heading={
                              <span className="flex items-center justify-between">
                                <span>{label}</span>
                                {models.length > 1 && (
                                  <button
                                    type="button"
                                    className="text-xs font-normal text-primary hover:underline"
                                    onPointerDown={(e) => {
                                      e.preventDefault();
                                      for (const m of models) addModel(m.model);
                                      setAddModelOpen(false);
                                    }}
                                  >
                                    Add all
                                  </button>
                                )}
                              </span>
                            }
                          >
                            {models.map((m) => (
                              <CommandItem
                                key={m.model}
                                value={`${label} ${m.name} ${m.model}`}
                                onSelect={() => {
                                  addModel(m.model);
                                  setAddModelOpen(false);
                                }}
                              >
                                <div>
                                  <div className="text-sm">{m.name}</div>
                                  <div className="text-xs text-muted-foreground">{m.model}</div>
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={addAllModels}
                  disabled={availableModels.length === 0}
                >
                  Add all models
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
