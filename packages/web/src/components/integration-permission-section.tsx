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
import {
  useIntegrationPermissions,
  type IntegrationPermissionsConfig,
  type IntegrationConnection,
  type IntegrationEntity,
  type AccessLevel,
} from "@/hooks/use-integration-permissions";

const ACCESS_LEVEL_OPTIONS: { value: AccessLevel; label: string }[] = [
  { value: "read-only", label: "Read-only" },
  { value: "read-write", label: "Read & Write" },
  { value: "full", label: "Full" },
  { value: "custom", label: "Custom" },
];

export interface IntegrationPermValues {
  connectionId: string;
  permissions: Array<{ model: string; operation: string }>;
}

export interface IntegrationPermissionSectionProps {
  agentId: string;
  integrationType: string;
  label: string;
  entityLabel: string;
  connections: IntegrationConnection[];
  hookConfig: IntegrationPermissionsConfig;
  operations: readonly string[];
  operationLabels: Record<string, string>;
  categorizeEntities?: (
    entities: IntegrationEntity[]
  ) => Array<{ label: string; entities: IntegrationEntity[] }>;
  restrictionTooltip?: string;
  onChange: (values: IntegrationPermValues | null, isDirty: boolean) => void;
}

// Note: `integrationType`, `label`, and `connections` are accepted as props for
// the parent to control rendering (e.g. section headings, conditional display).
// The component itself uses `hookConfig` (which embeds the type) and the hook
// fetches connections internally.

/** Default categorization: single flat group. */
function flatGroup(
  entities: IntegrationEntity[],
  entityLabel: string
): Array<{ label: string; entities: IntegrationEntity[] }> {
  if (entities.length === 0) return [];
  return [{ label: entityLabel, entities }];
}

export function IntegrationPermissionSection({
  agentId,
  entityLabel,
  hookConfig,
  operations,
  operationLabels,
  categorizeEntities,
  restrictionTooltip = "Not available — restricted by connection permissions",
  onChange,
}: IntegrationPermissionSectionProps) {
  const {
    connections,
    connectionId,
    accessLevel,
    addedEntities,
    availableEntities,
    loading,
    setConnectionId,
    setAccessLevel,
    addEntity,
    addAllEntities,
    removeEntity,
    toggleOperation,
    getEntityAccess,
    getPermissions,
    isDirty,
  } = useIntegrationPermissions(hookConfig, agentId);

  const [addEntityOpen, setAddEntityOpen] = useState(false);

  // Stable ref for onChange to avoid infinite re-render loops
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Notify parent of changes
  // Connection without entities = not configured -> report null
  useEffect(() => {
    if (loading) return;
    const perms = getPermissions();
    const hasConfig = connectionId && perms.length > 0;
    onChangeRef.current(hasConfig ? { connectionId, permissions: perms } : null, isDirty);
  }, [connectionId, addedEntities, loading, getPermissions, isDirty]);

  if (loading) {
    return <div className="text-muted-foreground py-4">Loading configuration...</div>;
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-muted-foreground">No connections configured.</p>
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

  // Get the selected connection to check for synced entities
  const selectedConnection = connections.find((c) => c.id === connectionId);
  const connectionEntities = selectedConnection?.data
    ? hookConfig.getEntitiesFromData(selectedConnection.data)
    : [];
  const hasEntities = connectionEntities.length > 0;

  // Categorize function (use provided one or flat fallback)
  const categorize = categorizeEntities ?? ((e: IntegrationEntity[]) => flatGroup(e, entityLabel));

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

      {/* Only show access level + entities when a connection is selected */}
      {connectionId && (
        <>
          {/* Access level */}
          <div className="space-y-3">
            <Label>Access</Label>
            <RadioGroup
              value={accessLevel}
              onValueChange={(v) => setAccessLevel(v as AccessLevel)}
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

          {/* No entities synced warning */}
          {!hasEntities && (
            <p className="text-sm text-muted-foreground">
              No {entityLabel.toLowerCase()} available. Sync the connection schema in Settings &gt;
              Integrations first.
            </p>
          )}

          {/* Entities section */}
          {hasEntities && (
            <div className="space-y-4">
              <Label>{entityLabel}</Label>

              {/* Entity table */}
              {addedEntities.size > 0 && (
                <div className="rounded-md border">
                  {/* Header */}
                  <div
                    className={`grid gap-2 border-b px-4 py-2 text-sm font-medium text-muted-foreground`}
                    style={{
                      gridTemplateColumns: `1fr ${operations.map(() => "60px").join(" ")} 40px`,
                    }}
                  >
                    <span>
                      {entityLabel.endsWith("s") ? entityLabel.slice(0, -1) : entityLabel}
                    </span>
                    {operations.map((op) => (
                      <span key={op} className="text-center">
                        {operationLabels[op] ?? op}
                      </span>
                    ))}
                    <span />
                  </div>

                  {/* Rows */}
                  <div className="max-h-[400px] overflow-y-auto">
                    {Array.from(addedEntities.entries()).map(([entityId, ops]) => {
                      // Look up display name from connection entities
                      const entityInfo = connectionEntities.find((e) => e.id === entityId);
                      const displayName = entityInfo?.name ?? entityId;
                      const category = entityInfo?.category;
                      const entityAccess = getEntityAccess(entityId);

                      return (
                        <div
                          key={entityId}
                          className="grid gap-2 border-b px-4 py-2 last:border-b-0 items-center"
                          style={{
                            gridTemplateColumns: `1fr ${operations.map(() => "60px").join(" ")} 40px`,
                          }}
                        >
                          <div>
                            <div className="text-sm font-medium">
                              {category && (
                                <span className="text-muted-foreground font-normal">
                                  {category}:{" "}
                                </span>
                              )}
                              {displayName}
                            </div>
                            <div className="text-xs text-muted-foreground">{entityId}</div>
                          </div>
                          {operations.map((op) => {
                            const restricted = !entityAccess[op];
                            const checkbox = (
                              <Checkbox
                                checked={ops[op]}
                                onCheckedChange={() => toggleOperation(entityId, op)}
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
                                      <TooltipContent>{restrictionTooltip}</TooltipContent>
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
                              onClick={() => removeEntity(entityId)}
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

              {/* Add entity controls */}
              <div className="flex items-center gap-2">
                <Popover open={addEntityOpen} onOpenChange={setAddEntityOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" disabled={availableEntities.length === 0}>
                      <Plus className="mr-1 h-4 w-4" />
                      Add{" "}
                      {entityLabel.toLowerCase().endsWith("s")
                        ? entityLabel.toLowerCase().slice(0, -1)
                        : entityLabel.toLowerCase()}
                      ...
                      <ChevronsUpDown className="ml-1 h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder={`Search ${entityLabel.toLowerCase()}...`} />
                      <CommandList>
                        <CommandEmpty>No {entityLabel.toLowerCase()} found.</CommandEmpty>
                        {categorize(availableEntities).map(({ label: groupLabel, entities }) => (
                          <CommandGroup
                            key={groupLabel}
                            heading={
                              <span className="flex items-center justify-between">
                                <span>{groupLabel}</span>
                                {entities.length > 1 && (
                                  <button
                                    type="button"
                                    className="text-xs font-normal text-primary hover:underline"
                                    onPointerDown={(e) => {
                                      e.preventDefault();
                                      for (const entity of entities) addEntity(entity.id);
                                      setAddEntityOpen(false);
                                    }}
                                  >
                                    Add all
                                  </button>
                                )}
                              </span>
                            }
                          >
                            {entities.map((entity) => (
                              <CommandItem
                                key={entity.id}
                                value={`${groupLabel} ${entity.name} ${entity.id}`}
                                onSelect={() => {
                                  addEntity(entity.id);
                                  setAddEntityOpen(false);
                                }}
                              >
                                <div>
                                  <div className="text-sm">{entity.name}</div>
                                  <div className="text-xs text-muted-foreground">{entity.id}</div>
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
                  onClick={addAllEntities}
                  disabled={availableEntities.length === 0}
                >
                  Add all {entityLabel.toLowerCase()}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
