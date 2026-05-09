"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeleteAgentDialog } from "@/components/delete-agent-dialog";

import { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";

const agentSettingsSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(AGENT_NAME_MAX_LENGTH, `Name must be ${AGENT_NAME_MAX_LENGTH} characters or less`),
  tagline: z.string(),
  model: z.string().min(1, "Model is required"),
});

type AgentSettingsValues = z.infer<typeof agentSettingsSchema>;

interface AgentSettingsGeneralProps {
  agent: { id: string; name: string; model: string; isPersonal?: boolean; tagline?: string | null };
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      compatible?: boolean;
      incompatibleReason?: string;
    }>;
  }>;
  canDelete?: boolean;
  onChange: (values: AgentSettingsValues, isDirty: boolean) => void;
}

export function AgentSettingsGeneral({
  agent,
  providers,
  canDelete,
  onChange,
}: AgentSettingsGeneralProps) {
  const form = useForm<AgentSettingsValues>({
    resolver: zodResolver(agentSettingsSchema),
    defaultValues: {
      name: agent.name,
      tagline: agent.tagline || "",
      model: agent.model,
    },
  });

  const values = useWatch({ control: form.control });

  useEffect(() => {
    onChange(
      {
        name: values.name ?? "",
        tagline: values.tagline ?? "",
        model: values.model ?? "",
      },
      form.formState.isDirty
    );
    // onChange must be stable (useCallback in parent) to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, form.formState.isDirty]);

  const providersWithModels = providers.filter((p) => p.models.length > 0);

  // Collect all model IDs from the allowlist to detect deprecated pinned models
  const allAllowlistedModelIds = new Set(
    providersWithModels.flatMap((p) => p.models.map((m) => m.id))
  );
  const isDeprecatedModel = agent.model !== "" && !allAllowlistedModelIds.has(agent.model);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#model") {
      document.getElementById("model")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form className="space-y-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input maxLength={AGENT_NAME_MAX_LENGTH} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="tagline"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tagline</FormLabel>
                <FormControl>
                  <Input placeholder="e.g. Answers questions from your HR documents" {...field} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="model"
            render={({ field }) => (
              <FormItem id="model">
                <FormLabel>Model</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {isDeprecatedModel && (
                      <SelectGroup>
                        <SelectItem value={agent.model}>
                          {agent.model} (no longer available)
                        </SelectItem>
                      </SelectGroup>
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
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>

      <div className="pt-4 border-t">
        <h3 className="text-sm font-medium mb-1">
          {agent.isPersonal ? "Personal agent" : "Shared agent"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {agent.isPersonal
            ? "This agent is private to its owner. Memory and conversations are isolated."
            : "All team members share this agent. Memory from all user conversations is shared across the team."}
        </p>
      </div>

      {canDelete && (
        <div className="pt-6 border-t">
          <h3 className="text-sm font-medium text-destructive mb-2">Danger Zone</h3>
          <DeleteAgentDialog agentId={agent.id} agentName={agent.name} />
        </div>
      )}
    </div>
  );
}
