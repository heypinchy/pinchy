"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { TemplateSelector } from "@/components/template-selector";
import { DirectoryPicker } from "@/components/directory-picker";
import { DocsLink } from "@/components/docs-link";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import { useRestart } from "@/components/restart-provider";

interface Template {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  defaultTagline: string | null;
}

interface Directory {
  path: string;
  name: string;
}

import { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";

const agentFormSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(AGENT_NAME_MAX_LENGTH, `Name must be ${AGENT_NAME_MAX_LENGTH} characters or less`),
  tagline: z.string(),
});

type AgentFormValues = z.infer<typeof agentFormSchema>;

export function NewAgentForm() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { triggerRestart } = useRestart();

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: { name: "", tagline: "" },
  });

  const fetchData = useCallback(async () => {
    const templatesRes = await fetch("/api/templates");
    if (templatesRes.ok) {
      const data = await templatesRes.json();
      setTemplates(data.templates);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectedTemplateObj = templates.find((t) => t.id === selectedTemplate);
  const requiresDirectories = selectedTemplateObj?.requiresDirectories ?? false;

  // Fetch directories when a template requiring them is selected
  useEffect(() => {
    if (!requiresDirectories) return;

    async function fetchDirectories() {
      const res = await fetch("/api/data-directories");
      if (res.ok) {
        const data = await res.json();
        setDirectories(data.directories || []);
      }
    }

    fetchDirectories();
  }, [requiresDirectories]);

  // Reset directory selection and pre-fill tagline when switching templates
  useEffect(() => {
    setSelectedPaths([]);
    setDirectories([]);
    if (selectedTemplateObj) {
      form.setValue("tagline", selectedTemplateObj.defaultTagline || "");
    }
  }, [selectedTemplate]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(values: AgentFormValues) {
    setError(null);
    setSubmitting(true);

    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        tagline: values.tagline?.trim() || null,
        templateId: selectedTemplate,
      };

      if (requiresDirectories && selectedPaths.length > 0) {
        body.pluginConfig = { allowed_paths: selectedPaths };
      }

      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create agent");
        return;
      }

      const agent = await res.json();
      triggerRestart();
      router.push(`/chat/${agent.id}`);
      router.refresh();
    } catch {
      setError("Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  }

  const createDisabled = submitting || (requiresDirectories && selectedPaths.length === 0);

  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Create New Agent</h1>

      {!selectedTemplate ? (
        <TemplateSelector templates={templates} onSelect={setSelectedTemplate} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setSelectedTemplate(null)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
          >
            <ArrowLeft className="h-4 w-4" /> Back to templates
          </button>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>New {selectedTemplateObj?.name ?? "Agent"}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="e.g. HR Knowledge Base"
                            maxLength={AGENT_NAME_MAX_LENGTH}
                            {...field}
                          />
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
                          <Input
                            placeholder="e.g. Answers HR questions from your documents"
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  {requiresDirectories && (
                    <div className="space-y-3">
                      <h4 className="text-sm font-medium">Data Directories</h4>
                      <DirectoryPicker
                        directories={directories}
                        selected={selectedPaths}
                        onChange={setSelectedPaths}
                      />

                      {directories.length === 0 && (
                        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
                          <Info className="h-4 w-4 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
                          <p className="text-sm text-blue-800 dark:text-blue-200">
                            You need to mount folders into <code>/data/</code> in your
                            docker-compose.yml to make them available here.{" "}
                            <DocsLink
                              path="guides/mount-data-directories"
                              className="underline font-medium"
                            >
                              How to mount data directories
                            </DocsLink>
                          </p>
                        </div>
                      )}

                      <DocsLink
                        path="guides/create-knowledge-base-agent"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Learn more about Knowledge Base agents
                      </DocsLink>
                    </div>
                  )}

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => router.back()}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createDisabled}>
                      {submitting ? "Creating..." : "Create"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </form>
          </Form>
        </>
      )}
    </div>
  );
}
