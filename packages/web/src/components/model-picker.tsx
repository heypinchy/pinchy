"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ModelEntry = {
  id: string;
  name: string;
  compatible?: boolean;
  incompatibleReason?: string;
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
                  {m.name}
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
