"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
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
import { ArrowLeft, Check, ExternalLink, Info, AlertTriangle, X } from "lucide-react";
import { useRestart } from "@/components/restart-provider";
import {
  validateOdooTemplate,
  type ValidationResult,
} from "@/lib/integrations/odoo-template-validation";
import { getTemplate, pickSuggestedName, type OdooTemplateConfig } from "@/lib/agent-templates";
import { autoSelectConnection, type OdooConnection } from "@/lib/odoo-connection-selection";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { getPermissionPreviewItems } from "@/lib/template-grouping";
import Link from "next/link";
import { toast } from "sonner";

const EMAIL_CONNECTION_TYPE_SET = new Set<string>(EMAIL_CONNECTION_TYPES);

interface Template {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection: boolean;
  requiresEmailConnection?: boolean;
  requiresWeb?: boolean;
  odooAccessLevel?: string;
  defaultTagline: string | null;
}

interface Directory {
  path: string;
  name: string;
}

import { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";
import { apiGet, apiPost, errorMessage } from "@/lib/api-client";
import type { CreateAgentInput } from "@/lib/schemas/agents";

const agentFormSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(AGENT_NAME_MAX_LENGTH, `Name must be ${AGENT_NAME_MAX_LENGTH} characters or less`),
  tagline: z.string(),
});

type AgentFormValues = z.infer<typeof agentFormSchema>;

function PermissionPreview({ template }: { template?: Template }) {
  if (!template) return null;
  const items = getPermissionPreviewItems(template);
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">What this agent can do</h4>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2 text-sm text-muted-foreground">
            {item.icon === "check" && <Check className="size-4 text-green-600 shrink-0" />}
            {item.icon === "cross" && <X className="size-4 text-muted-foreground/50 shrink-0" />}
            {item.icon === "warning" && (
              <AlertTriangle className="size-4 text-yellow-600 shrink-0" />
            )}
            {item.text}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">You can adjust permissions after creation.</p>
    </div>
  );
}

/**
 * Report a background load that failed — unless it was merely cancelled.
 *
 * Nothing awaits the promises the effects below start, so an uncaught rejection
 * has nowhere to land: in the browser it is a silent dead end, and in a test run
 * it surfaces as a suite-level unhandled rejection that ends `pnpm test` with
 * `Errors 1 error` and exit 1 while every test passes. Catching it is the fix.
 *
 * Catching it BLINDLY would be the next bug. An aborted request is the expected
 * outcome of every unmount and every template switch, not something to tell the
 * user about. The signal is the whole test: `controller.abort()` sets `aborted`
 * synchronously before the request rejects, and that controller is the only
 * abort source these requests have, so a real cancellation always arrives with
 * it already true. Matching on `err.name === "AbortError"` as well reads like
 * defence in depth and is not: it is unreachable for our own aborts, and the
 * only errors it can actually catch are AbortError-named failures from some
 * other layer — precisely the ones the user needs to hear about. Same reading
 * as `attachment-preview.tsx` and `knowledge/embeddings.ts`.
 */
function reportLoadFailure(err: unknown, signal: AbortSignal, fallback: string): void {
  if (signal.aborted) return;
  toast.error(errorMessage(err, fallback));
}

/**
 * Load the integrations list and hand back the rows a picker can actually use.
 *
 * Shared by the Odoo and the mailbox effect, which differ only in which `type`
 * they accept and what they call the result. Unreadable rows are dropped from
 * the agent-creation flow in both: they can't be selected and would render as
 * "undefined URL". Admins clean them up in Settings.
 */
async function loadUsableConnections(
  signal: AbortSignal,
  accepts: (type: string) => boolean
): Promise<OdooConnection[]> {
  const rows = await apiGet<OdooConnection[]>("/api/integrations", { signal });
  return (rows ?? []).filter((c) => accepts(c.type) && !c.cannotDecrypt);
}

export function NewAgentForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [templates, setTemplates] = useState<Template[]>([]);

  const [selectedTemplate, setSelectedTemplateState] = useState<string | null>(
    searchParams.get("template")
  );

  // Sync local state with URL (handles browser Back/Forward)
  useEffect(() => {
    let cancelled = false;
    const urlTemplate = searchParams.get("template");
    void Promise.resolve().then(() => {
      if (!cancelled) setSelectedTemplateState(urlTemplate);
    });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const setSelectedTemplate = useCallback(
    (templateId: string | null) => {
      setSelectedTemplateState(templateId);
      if (templateId) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("template", templateId);
        router.push(`/agents/new?${params.toString()}`);
      } else {
        router.replace(`/agents/new`);
      }
    },
    [router, searchParams]
  );
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { triggerRestart } = useRestart();

  // Odoo connection state
  const [odooConnections, setOdooConnections] = useState<OdooConnection[]>([]);
  // Email connection state (same /api/integrations row shape as Odoo)
  const [emailConnections, setEmailConnections] = useState<OdooConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loadingConnections, setLoadingConnections] = useState(false);

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: { name: "", tagline: "" },
  });

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  // Set when a suggested name has just been applied; the layout effect below
  // selects the field once, after the commit that puts the value in the DOM.
  const selectNameAfterCommitRef = useRef(false);

  // Select-all after the commit that applies a suggested name, so the user can
  // overtype. A layout effect runs synchronously after the DOM mutation (unlike
  // a `setTimeout`, which raced the template-switch re-renders and lost the
  // selection under load). Later renders don't change the name value, so React
  // won't reassign `node.value` and the selection survives.
  useLayoutEffect(() => {
    if (selectNameAfterCommitRef.current) {
      selectNameAfterCommitRef.current = false;
      nameInputRef.current?.select();
    }
  });

  const fetchData = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await apiGet<{ templates?: Template[] }>("/api/templates", { signal });
      // The signal doubles as the cancellation flag: a response that lost the
      // race against an unmount must not write itself into the new state.
      if (!signal.aborted) setTemplates(data?.templates ?? []);
    } catch (err) {
      reportLoadFailure(err, signal, "Couldn't load the agent templates. Try refreshing the page.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      // The signal is the only cancellation flag here — a separate boolean
      // would be a second mechanism answering the same question.
      if (!controller.signal.aborted) void fetchData(controller.signal);
    });
    return () => controller.abort();
  }, [fetchData]);

  const selectedTemplateObj = templates.find((t) => t.id === selectedTemplate);
  const requiresDirectories = selectedTemplateObj?.requiresDirectories ?? false;
  const requiresOdooConnection = selectedTemplateObj?.requiresOdooConnection ?? false;
  const requiresEmailConnection = selectedTemplateObj?.requiresEmailConnection ?? false;

  // Fetch directories when a template requiring them is selected
  useEffect(() => {
    if (!requiresDirectories) return;
    const controller = new AbortController();
    const { signal } = controller;

    async function fetchDirectories() {
      try {
        const data = await apiGet<{ directories?: Directory[] }>("/api/data-directories", {
          signal,
        });
        // The signal doubles as the cancellation flag: a response that lost
        // the race against an unmount or a template switch must not write
        // itself into the new state.
        if (!signal.aborted) setDirectories(data?.directories ?? []);
      } catch (err) {
        reportLoadFailure(err, signal, "Couldn't load the directories. Try refreshing the page.");
      }
    }

    void fetchDirectories();

    return () => controller.abort();
  }, [requiresDirectories]);

  // Reset Odoo state immediately when leaving an Odoo template — uses
  // "adjust state during render" so the UI hides the Odoo block in the same
  // commit as the template change.
  const [prevRequiresOdoo, setPrevRequiresOdoo] = useState(requiresOdooConnection);
  if (prevRequiresOdoo !== requiresOdooConnection) {
    setPrevRequiresOdoo(requiresOdooConnection);
    if (!requiresOdooConnection) {
      setOdooConnections([]);
      setSelectedConnectionId(null);
      setValidationResult(null);
    }
  }

  // Same pattern for email templates — hide the mailbox picker and drop the
  // stale selection in the same commit as the template change.
  const [prevRequiresEmail, setPrevRequiresEmail] = useState(requiresEmailConnection);
  if (prevRequiresEmail !== requiresEmailConnection) {
    setPrevRequiresEmail(requiresEmailConnection);
    if (!requiresEmailConnection) {
      setEmailConnections([]);
      setSelectedConnectionId(null);
    }
  }

  // Fetch Odoo connections when an Odoo template is selected
  useEffect(() => {
    if (!requiresOdooConnection) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      setLoadingConnections(true);
      try {
        const odoo = await loadUsableConnections(signal, (type) => type === "odoo");
        if (signal.aborted) return;
        setOdooConnections(odoo);
        // Auto-select if only one connection
        const autoSelected = autoSelectConnection(odoo);
        if (autoSelected) {
          setSelectedConnectionId(autoSelected);
        }
      } catch (err) {
        reportLoadFailure(
          err,
          signal,
          "Couldn't load the Odoo connections. Try refreshing the page."
        );
      } finally {
        if (!signal.aborted) setLoadingConnections(false);
      }
    })();
    // `loadingConnections` is one flag shared by this effect and the mailbox
    // one, so clearing it here — rather than only in the `finally`, which an
    // abort deliberately skips — is what keeps it owned by whichever effect is
    // currently mounted. React runs every cleanup before any setup, so the
    // successor's `true` always lands after this `false`.
    return () => {
      controller.abort();
      setLoadingConnections(false);
    };
  }, [requiresOdooConnection]);

  // Fetch email connections when an email template is selected
  useEffect(() => {
    if (!requiresEmailConnection) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      setLoadingConnections(true);
      try {
        // Every email provider counts, Google and Microsoft alike.
        const email = await loadUsableConnections(signal, (type) =>
          EMAIL_CONNECTION_TYPE_SET.has(type)
        );
        if (signal.aborted) return;
        setEmailConnections(email);
        // Auto-select if only one mailbox
        const autoSelected = autoSelectConnection(email);
        if (autoSelected) {
          setSelectedConnectionId(autoSelected);
        }
      } catch (err) {
        reportLoadFailure(err, signal, "Couldn't load the mailboxes. Try refreshing the page.");
      } finally {
        if (!signal.aborted) setLoadingConnections(false);
      }
    })();
    // Same shared-flag reasoning as the Odoo effect above.
    return () => {
      controller.abort();
      setLoadingConnections(false);
    };
  }, [requiresEmailConnection]);

  // Validate template against selected connection
  useEffect(() => {
    let cancelled = false;
    let nextResult: ValidationResult | null = null;
    if (selectedConnectionId && selectedTemplate) {
      const connection = odooConnections.find((c) => c.id === selectedConnectionId);
      const templateDef = getTemplate(selectedTemplate);
      if (connection?.data?.models && templateDef?.odooConfig) {
        nextResult = validateOdooTemplate(
          templateDef.odooConfig as OdooTemplateConfig,
          connection.data.models
        );
      }
    }
    void Promise.resolve().then(() => {
      if (!cancelled) setValidationResult(nextResult);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedConnectionId, selectedTemplate, odooConnections]);

  // Reset directory selection and pre-fill tagline/name when switching templates
  useEffect(() => {
    // One cancellation mechanism for the whole effect: the microtasks below read
    // the same signal the request is given, so there is no boolean answering the
    // question a second time and no way for the two to disagree.
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.resolve().then(() => {
      if (signal.aborted) return;
      setSelectedPaths([]);
      setDirectories([]);
      setOdooConnections([]);
      setEmailConnections([]);
      setSelectedConnectionId(null);
      setValidationResult(null);
      if (selectedTemplate) {
        const templateDef = getTemplate(selectedTemplate);
        form.setValue("tagline", templateDef?.defaultTagline || "");
      }
    });

    // Pre-fill name with a suggested name (except for custom template)
    if (selectedTemplate && selectedTemplate !== "custom") {
      void (async () => {
        // The one load here that stays silent when it fails, and deliberately:
        // the worst an unreadable agent list costs is a suggestion that repeats
        // a name, which the user is about to overtype anyway. Silence is not a
        // reason to skip the cancellation — this result lands in the form
        // itself, so a late one would overwrite a name already being typed.
        let existingNames: string[] = [];
        try {
          const agents = await apiGet<Array<{ name: string }>>("/api/agents", { signal });
          existingNames = (agents ?? []).map((a) => a.name);
        } catch {
          // Suggest from an empty list — see above.
        }
        if (signal.aborted) return;
        const suggested = pickSuggestedName(selectedTemplate, existingNames);
        if (suggested) {
          form.setValue("name", suggested);
          // Select all text so users can overtype immediately. The layout
          // effect performs the selection after the value is committed.
          selectNameAfterCommitRef.current = true;
        }
      })();
    } else if (selectedTemplate === "custom") {
      void Promise.resolve().then(() => {
        if (!signal.aborted) form.setValue("name", "");
      });
    }
    return () => controller.abort();
  }, [selectedTemplate]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(values: AgentFormValues) {
    // The form — and therefore this handler — only renders inside the
    // "a template is selected" branch. Stated rather than asserted, because
    // the create payload is typed against the route's schema and templateId is
    // required there.
    if (!selectedTemplate) return;

    setError(null);
    setSubmitting(true);

    try {
      // No defaultAllowedTools: permissions belong to the template, not to this
      // form. Injecting pinchy_write here gave every agent file-write access
      // (and, before memory became its own grant, a memory) regardless of what
      // the chosen template asked for — including "Custom Agent — Start from
      // scratch", which is supposed to start with nothing.
      //
      // createAgent still accepts the field; it is part of the API contract for
      // external clients. The first-party UI just stops using it.
      const body: CreateAgentInput = {
        name: values.name.trim(),
        tagline: values.tagline?.trim() || null,
        templateId: selectedTemplate,
      };

      if (requiresDirectories && selectedPaths.length > 0) {
        body.pluginConfig = { "pinchy-files": { allowed_paths: selectedPaths } };
      }

      if ((requiresOdooConnection || requiresEmailConnection) && selectedConnectionId) {
        body.connectionId = selectedConnectionId;
      }

      const agent = await apiPost<{ id: string; warning?: string }, CreateAgentInput>(
        "/api/agents",
        body
      );
      // #880 — the route creates the agent even when applying it to the OC
      // runtime fails, returning a non-blocking `warning` instead of a 500.
      // Surface it as a warning toast (sonner persists across the navigation
      // below) so the creation still reads as successful.
      if (typeof agent?.warning === "string" && agent.warning.length > 0) {
        toast.warning(agent.warning);
      }
      triggerRestart();
      router.push(`/chat/${agent.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e, "Failed to create agent"));
    } finally {
      setSubmitting(false);
    }
  }

  const hasMissingModels = validationResult !== null && validationResult.missingModels.length > 0;
  // A model the connection HAS but may not write is not a reason to refuse the
  // create — `validateOdooTemplate` deliberately leaves `valid` true for it, so
  // the agent is still useful for everything else. It IS a reason to say so
  // before the admin finds out from a "Permission denied" mid-conversation
  // (#1208), which is the same thing the create's audit row records.
  const deniedOperations = validationResult?.deniedOperations ?? [];

  const createDisabled =
    submitting ||
    (requiresDirectories && selectedPaths.length === 0) ||
    ((requiresOdooConnection || requiresEmailConnection) && !selectedConnectionId) ||
    hasMissingModels;

  return (
    <div className={"p-4 md:p-8 " + (selectedTemplate ? "max-w-lg" : "max-w-3xl")}>
      <h1 className="text-2xl font-bold mb-2">Create New Agent</h1>

      {!selectedTemplate ? (
        <>
          <p className="text-sm text-muted-foreground mb-6">
            Pick a template to get started — you can adjust all settings after creation.
          </p>
          <TemplateSelector templates={templates} onSelect={setSelectedTemplate} />
        </>
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
            <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-6">
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
                            placeholder="e.g. Smithers"
                            maxLength={AGENT_NAME_MAX_LENGTH}
                            autoFocus
                            {...field}
                            ref={(el) => {
                              field.ref(el);
                              nameInputRef.current = el;
                            }}
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
                        <FormDescription>Shown below the agent name in the sidebar</FormDescription>
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
                            No Odoo connections yet.{" "}
                            <Link
                              href="/settings?tab=integrations"
                              className="underline hover:text-foreground"
                            >
                              Set up connection →
                            </Link>
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

                      {hasMissingModels && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <p className="font-medium mb-1">Missing Odoo modules</p>
                            <p className="mb-2">
                              This template requires modules that are not available in the selected
                              connection. Install them in Odoo and re-sync, or choose a different
                              template.
                            </p>
                            <ul className="list-disc pl-4 space-y-0.5 text-xs">
                              {validationResult!.missingModels.map((model) => (
                                <li key={model}>{model}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}

                      {!hasMissingModels && deniedOperations.length > 0 && (
                        <Alert>
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <p className="font-medium mb-1">Limited Odoo access</p>
                            <p className="mb-2">
                              This connection has the models this template needs, but its Odoo user
                              may not perform every operation on them. You can still create the
                              agent — the rest of its work is unaffected. To close the gap, widen
                              the API user&apos;s rights in Odoo and re-sync the schema.
                            </p>
                            <ul className="list-disc pl-4 space-y-0.5 text-xs">
                              {deniedOperations.map((denied) => (
                                <li key={denied.model}>
                                  {denied.model} ({denied.operations.join(", ")})
                                </li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  )}

                  {requiresEmailConnection && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-sm font-medium">Mailbox</label>
                        {loadingConnections ? (
                          <p className="text-sm text-muted-foreground mt-1">
                            Loading connections...
                          </p>
                        ) : emailConnections.length === 0 ? (
                          // Normally unreachable — email templates are only
                          // offered when a mailbox exists — but kept as a
                          // defensive fallback.
                          <p className="text-sm text-muted-foreground mt-1">
                            No email connections yet.{" "}
                            <Link
                              href="/settings?tab=integrations"
                              className="underline hover:text-foreground"
                            >
                              Set up connection →
                            </Link>
                          </p>
                        ) : (
                          <Select
                            value={selectedConnectionId ?? undefined}
                            onValueChange={setSelectedConnectionId}
                          >
                            <SelectTrigger className="mt-1">
                              <SelectValue placeholder="Select a mailbox" />
                            </SelectTrigger>
                            <SelectContent>
                              {emailConnections.map((conn) => (
                                <SelectItem key={conn.id} value={conn.id}>
                                  {conn.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
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

                  <PermissionPreview template={selectedTemplateObj} />

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSelectedTemplate(null)}
                    >
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
