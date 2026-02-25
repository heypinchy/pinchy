"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { useRestart } from "@/components/restart-provider";

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
    models: Array<{ id: string; name: string }>;
  }>;
  onSaved?: () => void;
  canDelete?: boolean;
}

export function AgentSettingsGeneral({
  agent,
  providers,
  onSaved,
  canDelete,
}: AgentSettingsGeneralProps) {
  const { triggerRestart } = useRestart();
  const form = useForm<AgentSettingsValues>({
    resolver: zodResolver(agentSettingsSchema),
    defaultValues: {
      name: agent.name,
      tagline: agent.tagline || "",
      model: agent.model,
    },
  });

  const providersWithModels = providers.filter((p) => p.models.length > 0);

  async function onSubmit(values: AgentSettingsValues) {
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: values.name, tagline: values.tagline, model: values.model }),
      });

      if (!res.ok) {
        toast.error("Failed to save settings");
        return;
      }

      toast.success("Agent settings saved");
      triggerRestart();
      onSaved?.();
    } catch {
      toast.error("Failed to save settings");
    }
  }

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
              <FormItem>
                <FormLabel>Model</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {providersWithModels.map((provider) => (
                      <SelectGroup key={provider.id}>
                        <SelectLabel>{provider.name}</SelectLabel>
                        {provider.models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-3">
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Saving..." : "Save & restart"}
            </Button>

            <p className="text-sm text-muted-foreground">
              Saving will briefly disconnect all active chats while the agent runtime restarts.
            </p>
          </div>
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
