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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TemplateSelector } from "@/components/template-selector";
import { DirectoryPicker } from "@/components/directory-picker";
import { DocsLink } from "@/components/docs-link";
import { ArrowLeft, ExternalLink, Info, AlertTriangle } from "lucide-react";
import { useRestart } from "@/components/restart-provider";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { getTemplate, type OdooTemplateConfig } from "@/lib/agent-templates";
import { autoSelectConnection, type OdooConnection } from "@/lib/odoo-connection-selection";

interface Template {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection: boolean;
  odooAccessLevel?: string;
  defaultTagline: string | null;
}

interface Directory {
  path: string;
  name: string;
}

interface ValidationResult {
  valid: boolean;
  warnings: string[];
  availableModels: Array<{ model: string; operations: string[] }>;
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

  // Odoo connection state
  const [odooConnections, setOdooConnections] = useState<OdooConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loadingConnections, setLoadingConnections] = useState(false);

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
  const requiresOdooConnection = selectedTemplateObj?.requiresOdooConnection ?? false;

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

  // Fetch Odoo connections when an Odoo template is selected
  useEffect(() => {
    if (!requiresOdooConnection) {
      setOdooConnections([]);
      setSelectedConnectionId(null);
      setValidationResult(null);
      return;
    }

    async function fetchConnections() {
      setLoadingConnections(true);
      try {
        const res = await fetch("/api/integrations");
        if (res.ok) {
          const data = await res.json();
          const odoo = (data as OdooConnection[]).filter((c: OdooConnection) => c.type === "odoo");
          setOdooConnections(odoo);

          // Auto-select if only one connection
          const autoSelected = autoSelectConnection(odoo);
          if (autoSelected) {
            setSelectedConnectionId(autoSelected);
          }
        }
      } finally {
        setLoadingConnections(false);
      }
    }

    fetchConnections();
  }, [requiresOdooConnection]);

  // Validate template against selected connection
  useEffect(() => {
    if (!selectedConnectionId || !selectedTemplate) {
      setValidationResult(null);
      return;
    }

    const connection = odooConnections.find((c) => c.id === selectedConnectionId);
    if (!connection?.data?.models) {
      setValidationResult(null);
      return;
    }

    const templateDef = getTemplate(selectedTemplate);
    if (!templateDef?.odooConfig) {
      setValidationResult(null);
      return;
    }

    const result = validateOdooTemplate(
      templateDef.odooConfig as OdooTemplateConfig,
      connection.data.models
    );
    setValidationResult(result);
  }, [selectedConnectionId, selectedTemplate, odooConnections]);

  // Reset directory selection and pre-fill tagline when switching templates
  useEffect(() => {
    setSelectedPaths([]);
    setDirectories([]);
    setOdooConnections([]);
    setSelectedConnectionId(null);
    setValidationResult(null);
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

      if (requiresOdooConnection && selectedConnectionId) {
        body.connectionId = selectedConnectionId;
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

  const createDisabled =
    submitting ||
    (requiresDirectories && selectedPaths.length === 0) ||
    (requiresOdooConnection && !selectedConnectionId);

  return (
    <div className="p-4 md:p-8 max-w-lg">
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
            <ArrowLeft className="size-4" /> Back to templates
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

                  {requiresOdooConnection && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-sm font-medium">Connection</label>
                        {loadingConnections ? (
                          <p className="text-sm text-muted-foreground mt-1">
                            Loading connections...
                          </p>
                        ) : odooConnections.length === 0 ? (
                          <p className="text-sm text-muted-foreground mt-1">
                            No Odoo connections available.
                          </p>
                        ) : (
                          <Select
                            value={selectedConnectionId ?? undefined}
                            onValueChange={setSelectedConnectionId}
                          >
                            <SelectTrigger className="mt-1">
                              <SelectValue placeholder="Select a connection" />
                            </SelectTrigger>
                            <SelectContent>
                              {odooConnections.map((conn) => (
                                <SelectItem key={conn.id} value={conn.id}>
                                  {conn.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>

                      {validationResult && validationResult.warnings.length > 0 && (
                        <Alert>
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <ul className="list-disc pl-4 space-y-1">
                              {validationResult.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  )}

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
                          <Info className="size-4 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
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
                        <ExternalLink className="size-3" />
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
