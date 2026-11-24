"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  INTEGRATION_TYPES,
  isMcpType,
  type IntegrationType,
  type IntegrationTypeId,
} from "./integration-types";

interface IntegrationTypePickerProps {
  /**
   * Whether the MCP feature is enabled. Required (not defaulted) so the value
   * is always a deliberate decision by the caller: resolved per request from
   * PINCHY_MCP_ENABLED by the server component that owns this page and passed
   * down. See lib/feature-flags.ts for why this is a prop and not a
   * NEXT_PUBLIC_* read.
   */
  mcpEnabled: boolean;
  /**
   * IDs of integration types that may only have one connection at a time and
   * already have one configured — the matching tile renders disabled with a
   * tooltip explaining why. Today only "web-search" is a singleton.
   */
  configuredSingletons?: string[];
  onSelect: (id: IntegrationTypeId) => void;
}

// Types that only allow one active connection. Mirrors the same set inside
// AddIntegrationDialog — keep these in sync.
const SINGLETON_TYPES = new Set<string>(["web-search"]);

function TypeCard({
  type,
  disabled,
  disabledReason,
  onSelect,
}: {
  type: IntegrationType;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (id: IntegrationTypeId) => void;
}) {
  const Icon = type.icon;

  const card = (
    <Card
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? "true" : undefined}
      className={cn(
        "transition-colors",
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-primary"
      )}
      onClick={disabled ? undefined : () => onSelect(type.id as IntegrationTypeId)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " ") e.preventDefault();
      }}
      onKeyUp={(e) => {
        if (e.target !== e.currentTarget || disabled) return;
        if (e.key === "Enter" || e.key === " ") onSelect(type.id as IntegrationTypeId);
      }}
    >
      <CardContent className="flex flex-col items-center text-center p-4">
        <Icon className="size-8 mb-2 text-muted-foreground" />
        <h3 className="font-semibold">{type.name}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {disabled && disabledReason ? disabledReason : type.description}
        </p>
      </CardContent>
    </Card>
  );

  if (disabled && disabledReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{card}</TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return card;
}

/**
 * Grid of integration types, mirrored after the New-Agent template selector.
 * The "Custom MCP server" tile is visually separated as the catch-all option
 * for advanced users.
 *
 * MCP-backed tiles are hidden when the MCP feature is off — same gate the
 * dialog uses (see AddIntegrationDialog's visibleIntegrationTypes).
 */
export function IntegrationTypePicker({
  mcpEnabled,
  configuredSingletons = [],
  onSelect,
}: IntegrationTypePickerProps) {
  const visible = INTEGRATION_TYPES.filter((t) => mcpEnabled || !isMcpType(t.id));

  // Split Custom MCP server out of the main grid — visually distinct as a
  // catch-all for advanced users, matches how the New-Agent picker separates
  // "Start from scratch" from the templated options.
  const featured = visible.filter((t) => t.id !== "mcp-custom");
  const custom = visible.find((t) => t.id === "mcp-custom");

  function isDisabled(typeId: string) {
    return SINGLETON_TYPES.has(typeId) && configuredSingletons.includes(typeId);
  }

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {featured.map((type) => {
          const disabled = isDisabled(type.id);
          return (
            <TypeCard
              key={type.id}
              type={type}
              disabled={disabled}
              disabledReason={disabled ? "Already configured" : undefined}
              onSelect={onSelect}
            />
          );
        })}
      </div>

      {custom && (
        <div className="border-t pt-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <TypeCard type={custom} onSelect={onSelect} />
          </div>
        </div>
      )}
    </div>
  );
}
