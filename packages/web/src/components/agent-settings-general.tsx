"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AlertTriangle, Plus, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DeleteAgentDialog } from "@/components/delete-agent-dialog";
import { ModelPicker } from "@/components/model-picker";
import { useModelCapabilities } from "@/hooks/use-model-capabilities";
import { attachCapabilities } from "@/lib/model-capabilities/attach-capabilities";
import { getAgentModelBlockReason, markToolBlockedModels } from "@/lib/model-resolver/blocklist";

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

/** Values emitted to the parent on change. Adds starterPrompts (local state) to the form fields. */
export type GeneralChangeValues = AgentSettingsValues & { starterPrompts: string[] };

interface AgentSettingsGeneralProps {
  agent: {
    id: string;
    name: string;
    model: string;
    isPersonal?: boolean;
    tagline?: string | null;
    starterPrompts?: string[];
  };
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
  onChange: (values: GeneralChangeValues, isDirty: boolean) => void;
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

  // Starter prompts are managed as local state (a repeatable text list) rather
  // than a react-hook-form field array — keeps the form schema focused on the
  // validated scalars and avoids a FieldArray typing mismatch with the
  // zodResolver generic. The onChange effect below merges them into the values
  // the parent saves.
  const initialPrompts = agent.starterPrompts ?? [];
  const [starterPrompts, setStarterPrompts] = useState<string[]>(initialPrompts);
  const initialPromptsRef = useRef(initialPrompts);

  const values = useWatch({ control: form.control });

  // Join the configured model list (from /api/providers/models, which carries no
  // capability flags) with the capability map so the picker can render each
  // model's capability icons. Undefined while the map loads → icon-free, no crash.
  const { data: capabilities } = useModelCapabilities();
  // Attach capability icons, then disable models the tools-blocklist flags as
  // unreliable for the function-calling loop every agent runs (e.g.
  // gemini-3-flash-preview). This stops the gap that let an agent be pointed at
  // a tool-broken model and silently fail at runtime.
  const providersWithCapabilities = useMemo(
    () => markToolBlockedModels(attachCapabilities(providers, capabilities)),
    [providers, capabilities]
  );

  // Non-destructive surfacing of an EXISTING bad assignment: an agent created
  // before the blocklist (or via a path that skipped it) keeps its model until
  // an admin changes it. We don't rewrite it — we warn, and the picker above
  // guides them to a working model. Driven by the live form value so the warning
  // clears the moment they pick a reliable model.
  const currentModelBlockReason = values.model ? getAgentModelBlockReason(values.model) : null;

  useEffect(() => {
    onChange(
      {
        name: values.name ?? "",
        tagline: values.tagline ?? "",
        model: values.model ?? "",
        starterPrompts,
      },
      form.formState.isDirty ||
        JSON.stringify(starterPrompts) !== JSON.stringify(initialPromptsRef.current)
    );
    // onChange must be stable (useCallback in parent) to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, form.formState.isDirty, starterPrompts]);

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
                <FormControl>
                  <ModelPicker
                    value={field.value}
                    onChange={field.onChange}
                    providers={providersWithCapabilities}
                    deprecatedModelId={agent.model}
                  />
                </FormControl>
                {currentModelBlockReason && (
                  <Alert variant="destructive" className="mt-2">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>This model is unreliable for tool use</AlertTitle>
                    <AlertDescription>
                      {currentModelBlockReason} Pick a recommended model above to keep this agent
                      working.
                    </AlertDescription>
                  </Alert>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Starter prompts (#570) — clickable chips in the empty chat. */}
          <FormItem>
            <FormLabel>Starter prompts</FormLabel>
            <p className="text-sm text-muted-foreground">
              Shown as clickable suggestions in an empty chat to help users start a conversation
              with this agent.
            </p>
            <div className="space-y-2">
              {starterPrompts.map((prompt, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={prompt}
                    onChange={(e) =>
                      setStarterPrompts((prev) =>
                        prev.map((p, i) => (i === index ? e.target.value : p))
                      )
                    }
                    placeholder="e.g. Summarize my latest HR tickets"
                    maxLength={500}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setStarterPrompts((prev) => prev.filter((_, i) => i !== index))}
                    aria-label={`Remove starter prompt ${index + 1}`}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStarterPrompts((prev) => [...prev, ""])}
              >
                <Plus className="mr-1 size-4" />
                Add prompt
              </Button>
            </div>
          </FormItem>
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
