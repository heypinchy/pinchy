"use client";

import { Image, FileText, AudioLines, Video, AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelCapability } from "@/lib/model-resolver/types";

type ModelCapabilities = {
  vision: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
};

type ModelEntry = {
  id: string;
  name: string;
  compatible?: boolean;
  incompatibleReason?: string;
  capabilities?: ModelCapabilities;
};

type ProviderGroup = {
  id: string;
  name: string;
  models: ModelEntry[];
};

type ModelPickerProps = {
  value: string;
  onChange: (modelId: string) => void;
  providers: ProviderGroup[];
  deprecatedModelId?: string;
  requiredCapabilities?: ModelCapability[];
  filterToCompatible?: boolean;
};

const CAPABILITY_ICONS = [
  { key: "vision" as const, Icon: Image, label: "Supports image input" },
  { key: "documents" as const, Icon: FileText, label: "Supports document input" },
  { key: "audio" as const, Icon: AudioLines, label: "Supports audio input" },
  { key: "video" as const, Icon: Video, label: "Supports video input" },
];

type CheckableCapability = keyof ModelCapabilities;
const CHECKABLE_CAPABILITIES = new Set<string>(["vision", "documents", "audio", "video"]);

function CapabilityBadges({ caps }: { caps: ModelCapabilities }) {
  return (
    <span className="ml-2 inline-flex items-center gap-1">
      {CAPABILITY_ICONS.filter((c) => caps[c.key]).map(({ key, Icon, label }) => (
        <TooltipProvider key={key}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Icon className="size-3.5 text-muted-foreground" aria-label={label} />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ))}
    </span>
  );
}

function getMissingCapabilities(
  caps: ModelCapabilities | undefined,
  required: ModelCapability[]
): CheckableCapability[] {
  return required.filter(
    (cap): cap is CheckableCapability =>
      CHECKABLE_CAPABILITIES.has(cap) && !caps?.[cap as CheckableCapability]
  );
}

export function ModelPicker({
  value,
  onChange,
  providers,
  deprecatedModelId,
  requiredCapabilities,
  filterToCompatible,
}: ModelPickerProps) {
  const providersWithModels = providers.filter((p) => p.models.length > 0);

  const allAllowlistedModelIds = new Set(
    providersWithModels.flatMap((p) => p.models.map((m) => m.id))
  );
  const isDeprecatedModel =
    deprecatedModelId !== undefined &&
    deprecatedModelId !== "" &&
    !allAllowlistedModelIds.has(deprecatedModelId);

  return (
    <Select onValueChange={onChange} defaultValue={value}>
      <SelectTrigger>
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent>
        {isDeprecatedModel && deprecatedModelId && (
          <SelectItem value={deprecatedModelId} className="text-muted-foreground">
            {deprecatedModelId} (no longer available)
          </SelectItem>
        )}
        {providersWithModels.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectLabel>{provider.name}</SelectLabel>
            {provider.models.map((m) => {
              const missingCaps =
                requiredCapabilities && requiredCapabilities.length > 0
                  ? getMissingCapabilities(m.capabilities, requiredCapabilities)
                  : [];

              if (filterToCompatible && missingCaps.length > 0) {
                return null;
              }

              const isDisabled = m.compatible === false;
              const warningLabel =
                missingCaps.length > 0
                  ? `Doesn't satisfy required capability: ${missingCaps.join(", ")}`
                  : undefined;

              return (
                <SelectItem key={m.id} value={m.id} disabled={isDisabled}>
                  <span className="inline-flex items-center">
                    {m.name}
                    {m.capabilities && <CapabilityBadges caps={m.capabilities} />}
                    {warningLabel && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertTriangle
                              className="ml-1 size-3.5 text-amber-500"
                              aria-label={warningLabel}
                            />
                          </TooltipTrigger>
                          <TooltipContent>{warningLabel}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </span>
                  {isDisabled && m.incompatibleReason && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {m.incompatibleReason}
                    </span>
                  )}
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
