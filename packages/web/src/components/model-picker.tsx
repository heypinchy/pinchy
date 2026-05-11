"use client";

import { Image, FileText, AudioLines, Video } from "lucide-react";
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
};

const CAPABILITY_ICONS = [
  { key: "vision" as const, Icon: Image, label: "Supports image input" },
  { key: "documents" as const, Icon: FileText, label: "Supports document input" },
  { key: "audio" as const, Icon: AudioLines, label: "Supports audio input" },
  { key: "video" as const, Icon: Video, label: "Supports video input" },
];

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

export function ModelPicker({ value, onChange, providers, deprecatedModelId }: ModelPickerProps) {
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
              const isDisabled = m.compatible === false;
              return (
                <SelectItem key={m.id} value={m.id} disabled={isDisabled}>
                  <span className="inline-flex items-center">
                    {m.name}
                    {m.capabilities && <CapabilityBadges caps={m.capabilities} />}
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
