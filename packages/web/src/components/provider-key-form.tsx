"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Lock,
  ChevronDown,
  ExternalLink,
  CircleCheck,
  CircleX,
  Globe,
  Plus,
  Server,
  Check,
  Star,
} from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { useRestart } from "@/components/restart-provider";
import { ReportIssueLink } from "@/components/report-issue-link";
import { docsUrl } from "@/components/docs-link";
import {
  OpenAiCompatibleProviderForm,
  type ProviderListItem,
} from "@/components/openai-compatible-provider-form";
import type { ProviderName } from "@/lib/providers";
import { apiGet, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
import type { DeleteOpenAiCompatibleInput } from "@/lib/schemas/openai-compatible-provider";
import type { SetDefaultProviderInput } from "@/lib/schemas/provider-default";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const providerKeySchema = z.object({
  apiKey: z.string().min(1, "Required"),
});

type ProviderKeyFormValues = z.infer<typeof providerKeySchema>;

interface ProviderStep {
  label: string;
  optional?: boolean;
  link?: { text: string; url: string };
}

interface ProviderGuide {
  keyUrl: string;
  steps: ProviderStep[];
}

const PROVIDERS: Record<
  ProviderName,
  {
    name: string;
    placeholder: string;
    prefix: string;
    authType: "api-key" | "url";
    guide: ProviderGuide;
  }
> = {
  anthropic: {
    name: "Anthropic",
    placeholder: "sk-ant-...",
    prefix: "sk-ant-",
    authType: "api-key" as const,
    guide: {
      keyUrl: "https://platform.claude.com/settings/keys",
      steps: [
        {
          label: "Sign up at platform.claude.com",
          optional: true,
          link: { text: "platform.claude.com", url: "https://platform.claude.com" },
        },
        { label: "Open API Keys in the left sidebar" },
        { label: "Click Create Key and copy it immediately" },
        { label: "Add a payment method under Plans & Billing", optional: true },
      ],
    },
  },
  openai: {
    name: "OpenAI",
    placeholder: "sk-...",
    prefix: "sk-",
    authType: "api-key" as const,
    guide: {
      keyUrl: "https://platform.openai.com/api-keys",
      steps: [
        {
          label: "Sign up at platform.openai.com",
          optional: true,
          link: { text: "platform.openai.com", url: "https://platform.openai.com" },
        },
        { label: "Open API Keys in the left sidebar" },
        { label: "Click Create new secret key and copy it immediately" },
        { label: "Add a payment method under Billing", optional: true },
      ],
    },
  },
  google: {
    name: "Google",
    placeholder: "AIza...",
    prefix: "AIza",
    authType: "api-key" as const,
    guide: {
      keyUrl: "https://aistudio.google.com/apikey",
      steps: [
        {
          label: "Sign in with your Google account at aistudio.google.com",
          optional: true,
          link: { text: "aistudio.google.com", url: "https://aistudio.google.com" },
        },
        { label: "Click Get API key in the left sidebar" },
        { label: "Click Create API key and copy it" },
      ],
    },
  },
  "ollama-cloud": {
    name: "Ollama Cloud",
    placeholder: "sk-...",
    prefix: "sk-",
    authType: "api-key" as const,
    guide: {
      keyUrl: "https://ollama.com/settings/keys",
      steps: [
        {
          label: "Sign up at ollama.com",
          optional: true,
          link: { text: "ollama.com", url: "https://ollama.com" },
        },
        { label: "Go to Settings > API Keys" },
        { label: "Click Create Key and copy it immediately" },
      ],
    },
  },
  "ollama-local": {
    name: "Ollama (Local)",
    placeholder: "http://host.docker.internal:11434",
    prefix: "",
    authType: "url" as const,
    guide: {
      keyUrl: docsUrl("guides/ollama-setup"),
      steps: [
        {
          label: "Install Ollama from ollama.com",
          link: { text: "ollama.com", url: "https://ollama.com/download" },
        },
        { label: "Pull a model with tool support: ollama pull qwen2.5:7b" },
        { label: "Ensure Ollama is running" },
        {
          label: "Use host.docker.internal:11434 when Ollama runs on the host and Pinchy in Docker",
        },
      ],
    },
  },
};

function renderStepWithLink(label: string, link: { text: string; url: string }) {
  const index = label.indexOf(link.text);
  if (index === -1) return label;
  const before = label.slice(0, index);
  const after = label.slice(index + link.text.length);
  return (
    <>
      {before}
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-accent hover:underline"
      >
        {link.text}
      </a>
      {after}
    </>
  );
}

// Providers whose default models are always vision-capable
const VISION_CAPABLE_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "anthropic",
  "openai",
  "google",
  "ollama-cloud",
]);

type TileState = "default" | "configured" | "none";

/** default first, then configured, then unconfigured — the tile grid's sort order. */
function tileRank(state: TileState): number {
  return state === "default" ? 0 : state === "configured" ? 1 : 2;
}

/**
 * The status marker in a tile's TOP-RIGHT corner: a filled star for the default
 * provider, a quiet check for a configured-but-not-default one, nothing
 * otherwise. Absolutely positioned so it never affects the tile's layout — the
 * glyph + name stay vertically centered and every tile is the same height (an
 * earlier reserved BOTTOM row left indicator-less tiles looking top-heavy).
 *
 * "Default" (not "Active") is the single term for "new agents use this by
 * default", matching the "Set as default" action and the GitHub/Stripe/Msty
 * convention. Decorative (`aria-hidden`) so the button's accessible name stays
 * the provider name; a `<title>` gives a hover tooltip, and tests use the testids.
 */
function CornerIndicator({ state }: { state: TileState }) {
  if (state === "default") {
    return (
      <span
        data-testid="tile-default"
        aria-hidden="true"
        title="Default"
        className="absolute right-2 top-2"
      >
        <Star className="size-3.5 fill-muted-foreground text-muted-foreground" />
      </span>
    );
  }
  if (state === "configured") {
    return (
      <span
        data-testid="tile-configured"
        aria-hidden="true"
        title="Configured"
        className="absolute right-2 top-2"
      >
        <Check className="size-3.5 text-muted-foreground" />
      </span>
    );
  }
  return null;
}

interface ProviderKeyFormProps {
  onSuccess: (provider?: ProviderName) => void;
  submitLabel?: string;
  configuredProviders?: Record<string, { configured: boolean; hint?: string }>;
  defaultProvider?: string | null;
  onDirtyChange?: (isDirty: boolean) => void;
  /**
   * Called after a successful save. Receives the provider name and whether
   * the provider's default models include vision capability.
   */
  onSaved?: (provider: ProviderName, hasVision: boolean) => void;
  /**
   * Setup wizard only (#894): offer a "Custom provider" action below the
   * built-in tiles that swaps in the multi-field custom provider form. Off by
   * default so the settings page — which manages custom providers via
   * `manageCustomProviders` below — doesn't show it twice.
   */
  showOpenAiCompatibleOption?: boolean;
  /**
   * Called after a custom OpenAI-compatible provider is saved from the wizard.
   * The custom POST sets `default_provider` itself, so the wizard can advance
   * straight to the app with a usable default.
   */
  onOpenAiCompatibleSaved?: () => void;
  /**
   * Settings page only (#894 redesign): renders ONE unified provider grid —
   * the 5 built-in tiles PLUS one tile per configured custom OpenAI-compatible
   * provider PLUS a dashed "Add custom provider" tile — instead of the
   * built-ins-only grid the setup wizard shows. Also renders an explicit
   * "Set as default" action on every configured tile's panel (built-in or
   * custom) and the delete affordance for custom providers. Fetches the
   * custom-provider list itself via `GET .../openai-compatible`. Off by
   * default so the wizard's grid — which mustn't change — is unaffected.
   */
  manageCustomProviders?: boolean;
}

export function ProviderKeyForm({
  onSuccess,
  submitLabel = "Continue",
  configuredProviders,
  defaultProvider,
  onDirtyChange,
  onSaved,
  showOpenAiCompatibleOption = false,
  onOpenAiCompatibleSaved,
  manageCustomProviders = false,
}: ProviderKeyFormProps) {
  const [provider, setProvider] = useState<ProviderName | null>(null);
  // Custom "OpenAI-compatible" is not a built-in `ProviderName`, so it can't
  // live in `provider`; a separate flag drives whether the ADD form shows
  // (used by both the wizard's dashed "Custom" tile and settings' "Add custom
  // provider" tile).
  const [customSelected, setCustomSelected] = useState(false);
  // Settings-only (#894): the existing custom provider tile currently
  // selected, if any — drives the edit-mode panel below the grid.
  const [customProviders, setCustomProviders] = useState<ProviderListItem[]>([]);
  const [selectedCustomProvider, setSelectedCustomProvider] = useState<ProviderListItem | null>(
    null
  );
  const [settingDefault, setSettingDefault] = useState(false);
  const [deletingCustom, setDeletingCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [validationStatus, setValidationStatus] = useState<"idle" | "success" | "error">("idle");
  const [error, setError] = useState("");
  // #296 — when the API returns a structured `docs` hint alongside the error
  // (currently only for `unsupported_local_host` from /api/setup/provider),
  // we render it as a clickable <a> next to the inline error text instead of
  // letting a long URL squat inside the prose.
  const [errorDocs, setErrorDocs] = useState<{ href: string; label: string } | null>(null);
  const { triggerRestart } = useRestart();

  const form = useForm<ProviderKeyFormValues>({
    resolver: zodResolver(providerKeySchema),
    defaultValues: { apiKey: "" },
  });

  const apiKeyValue = form.watch("apiKey");

  useEffect(() => {
    onDirtyChange?.(!!provider && apiKeyValue.trim().length > 0);
  }, [provider, apiKeyValue, onDirtyChange]);

  // Settings-only: fetch the custom provider list for the unified grid. Not
  // fetched in the wizard (manageCustomProviders is false there).
  const fetchCustomProviders = useCallback(async () => {
    if (!manageCustomProviders) return;
    try {
      const rows = await apiGet<ProviderListItem[]>("/api/settings/providers/openai-compatible");
      setCustomProviders(rows);
    } catch {
      // Non-blocking: the grid just shows the built-ins + Add tile on a read
      // failure, same as the old OpenAiCompatibleProvidersSection's empty state.
    }
  }, [manageCustomProviders]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void fetchCustomProviders();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCustomProviders]);

  // Settings-only: flip `default_provider` to a built-in name or a custom
  // slug. Shared by both the built-in panel's and the custom panel's
  // "Set as default" button.
  async function handleSetDefault(target: string) {
    setSettingDefault(true);
    try {
      const body: SetDefaultProviderInput = { provider: target };
      await apiPatch<{ success: true; defaultProvider: string; warning?: string }>(
        "/api/settings/providers/default",
        body
      );
      toast.success("Default provider updated.");
      onSuccess();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not set the default provider.");
    } finally {
      setSettingDefault(false);
    }
  }

  // Settings-only: remove a custom provider, reusing the AlertDialog delete
  // flow that used to live in `OpenAiCompatibleProvidersSection`.
  async function handleDeleteCustomProvider(target: ProviderListItem) {
    setDeletingCustom(true);
    try {
      const body: DeleteOpenAiCompatibleInput = { id: target.id };
      await apiDelete<{ ok: true }, DeleteOpenAiCompatibleInput>(
        "/api/settings/providers/openai-compatible",
        body
      );
      toast.success("Provider removed.");
      setSelectedCustomProvider(null);
      void fetchCustomProviders();
      onSuccess();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not remove the provider.");
    } finally {
      setDeletingCustom(false);
    }
  }

  const isConfigured = provider ? configuredProviders?.[provider]?.configured === true : false;
  const isUrlProvider = provider ? PROVIDERS[provider].authType === "url" : false;
  const hint = provider ? configuredProviders?.[provider]?.hint : undefined;
  const maskedPlaceholder =
    provider && isConfigured && hint
      ? `${PROVIDERS[provider].prefix}····${hint}`
      : provider
        ? PROVIDERS[provider].placeholder
        : "";

  async function onSubmit(values: ProviderKeyFormValues) {
    if (!provider) return;

    setLoading(true);
    setError("");
    setErrorDocs(null);
    setValidationStatus("idle");

    try {
      const body = isUrlProvider
        ? { provider, url: values.apiKey }
        : { provider, apiKey: values.apiKey };

      const res = await fetch("/api/setup/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Session expired — redirect to login
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        let message = "Setup failed";
        let docs: { href: string; label: string } | null = null;
        try {
          const data = await res.json();
          if (data.error) message = data.error;
          // Validate the docs shape defensively — a route that returns
          // partial/malformed metadata shouldn't break the inline error, and
          // the href must be a real http(s) URL so a compromised/buggy route
          // can never coax the client into rendering a `javascript:` anchor.
          // An empty label would render an icon-only click target, which is
          // worse than no link — treat it as "no docs".
          if (
            data.docs &&
            typeof data.docs.href === "string" &&
            /^https?:\/\//i.test(data.docs.href) &&
            typeof data.docs.label === "string" &&
            data.docs.label.length > 0
          ) {
            docs = { href: data.docs.href, label: data.docs.label };
          }
        } catch {
          // response body was not JSON; use default message
        }
        setErrorDocs(docs);
        throw new Error(message);
      }

      // #880 — the route persists the key even when applying it to the OC
      // runtime fails, and returns a non-blocking `warning` instead of a 500.
      // Surface it as a warning toast so the save still reads as successful.
      let warning: string | undefined;
      try {
        const data = await res.json();
        if (typeof data?.warning === "string" && data.warning.length > 0) {
          warning = data.warning;
        }
      } catch {
        // No/!JSON body — treat as a plain success.
      }

      setValidationStatus("success");
      form.reset();
      if (warning) {
        toast.warning(warning);
      } else {
        toast.success(isUrlProvider ? "URL saved" : "API key saved");
      }
      triggerRestart();
      onSaved?.(provider, VISION_CAPABLE_PROVIDERS.has(provider));
      onSuccess(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      setValidationStatus("error");
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  // Unified, sorted tile list for the grid: the 5 built-ins, plus (in settings
  // mode) one tile per custom provider, ordered default → configured →
  // unconfigured. Sorting is stable, so built-ins stay ahead of customs within a
  // rank, and the wizard (every state "none") keeps PROVIDERS order untouched.
  const builtinTiles = (
    Object.entries(PROVIDERS) as [ProviderName, (typeof PROVIDERS)[ProviderName]][]
  ).map(([key, config]) => ({
    kind: "builtin" as const,
    key,
    config,
    state: (defaultProvider === key
      ? "default"
      : configuredProviders?.[key]?.configured
        ? "configured"
        : "none") as TileState,
  }));
  const customTiles = manageCustomProviders
    ? customProviders.map((row) => ({
        kind: "custom" as const,
        row,
        state: (defaultProvider === row.slug ? "default" : "configured") as TileState,
      }))
    : [];
  const sortedTiles = [...builtinTiles, ...customTiles].sort(
    (a, b) => tileRank(a.state) - tileRank(b.state)
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-6">
        <div className="space-y-2">
          <Label>Provider</Label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {sortedTiles.map((tile) =>
              tile.kind === "builtin" ? (
                <button
                  key={`builtin-${tile.key}`}
                  type="button"
                  onClick={() => {
                    setProvider(tile.key);
                    setCustomSelected(false);
                    setSelectedCustomProvider(null);
                    form.reset();
                    setGuideOpen(false);
                    setValidationStatus("idle");
                    setError("");
                    setErrorDocs(null);
                  }}
                  className={cn(
                    "relative flex w-full flex-col items-center justify-center gap-1.5 rounded-md border p-3 text-sm transition-colors",
                    provider === tile.key
                      ? "border-2 border-primary bg-primary/5 font-medium"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <CornerIndicator state={tile.state} />
                  <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
                  >
                    <ProviderLogo provider={tile.key} />
                  </span>
                  <span>{tile.config.name}</span>
                </button>
              ) : (
                <button
                  key={`custom-${tile.row.id}`}
                  type="button"
                  onClick={() => {
                    setSelectedCustomProvider(tile.row);
                    setProvider(null);
                    setCustomSelected(false);
                    form.reset();
                    setGuideOpen(false);
                    setValidationStatus("idle");
                    setError("");
                    setErrorDocs(null);
                  }}
                  className={cn(
                    "relative flex w-full flex-col items-center justify-center gap-1.5 rounded-md border p-3 text-sm transition-colors",
                    selectedCustomProvider?.id === tile.row.id
                      ? "border-2 border-primary bg-primary/5 font-medium"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <CornerIndicator state={tile.state} />
                  <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
                  >
                    <Server className="size-3.5" />
                  </span>
                  <span className="truncate max-w-full">{tile.row.displayName}</span>
                </button>
              )
            )}
            {manageCustomProviders && (
              <button
                type="button"
                aria-label="Add custom provider"
                onClick={() => {
                  setCustomSelected(true);
                  setProvider(null);
                  setSelectedCustomProvider(null);
                  form.reset();
                  setGuideOpen(false);
                  setValidationStatus("idle");
                  setError("");
                  setErrorDocs(null);
                }}
                className={cn(
                  "flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed p-3 text-sm transition-colors",
                  customSelected
                    ? "border-2 border-primary bg-primary/5 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                <span aria-hidden="true" className="flex size-6 items-center justify-center">
                  <Plus className="size-4" />
                </span>
                <span>Add custom provider</span>
              </button>
            )}
            {showOpenAiCompatibleOption && (
              <button
                type="button"
                aria-label="Custom provider"
                onClick={() => {
                  setCustomSelected(true);
                  setProvider(null);
                  form.reset();
                  setGuideOpen(false);
                  setValidationStatus("idle");
                  setError("");
                  setErrorDocs(null);
                }}
                className={cn(
                  "flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed p-3 text-sm transition-colors",
                  customSelected
                    ? "border-2 border-primary bg-primary/5 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                <span aria-hidden="true" className="flex size-6 items-center justify-center">
                  <Plus className="size-4" />
                </span>
                <span>Custom</span>
              </button>
            )}
          </div>
          {showOpenAiCompatibleOption && (
            <p className="text-xs text-muted-foreground">
              Custom connects any OpenAI-compatible endpoint — sovereign EU clouds, self-hosted
              vLLM, or a gateway.
            </p>
          )}
        </div>

        {customSelected && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Connect any OpenAI-compatible endpoint — sovereign EU providers, self-hosted vLLM or
              LiteLLM, or a gateway in front of your own models.
            </p>
            <OpenAiCompatibleProviderForm
              provider={null}
              onSaved={() => {
                if (manageCustomProviders) {
                  setCustomSelected(false);
                  void fetchCustomProviders();
                  onSuccess();
                } else {
                  onOpenAiCompatibleSaved?.();
                }
              }}
              onCancel={() => setCustomSelected(false)}
            />
          </div>
        )}

        {manageCustomProviders && selectedCustomProvider && (
          <div className="space-y-4">
            <OpenAiCompatibleProviderForm
              key={selectedCustomProvider.id}
              provider={selectedCustomProvider}
              onSaved={() => {
                setSelectedCustomProvider(null);
                void fetchCustomProviders();
                onSuccess();
              }}
              onCancel={() => setSelectedCustomProvider(null)}
            />
            {defaultProvider !== selectedCustomProvider.slug && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={settingDefault}
                onClick={() => handleSetDefault(selectedCustomProvider.slug)}
              >
                <Star className="size-4 fill-muted-foreground text-muted-foreground" />
                {settingDefault ? "Setting as default..." : "Set as default"}
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive"
                  disabled={deletingCustom}
                >
                  {deletingCustom ? "Removing..." : "Remove provider"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove provider?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {selectedCustomProvider.displayName}. Any agents using its models
                    will be switched to another configured provider.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deletingCustom}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={deletingCustom}
                    onClick={() => handleDeleteCustomProvider(selectedCustomProvider)}
                  >
                    {deletingCustom ? "Removing..." : "Remove"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {provider && (
          <>
            <FormField
              control={form.control}
              name="apiKey"
              render={({ field }) => (
                <FormItem className="space-y-2">
                  <FormLabel>{isUrlProvider ? "Ollama URL" : "API Key"}</FormLabel>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Input
                        type={isUrlProvider ? "text" : "password"}
                        placeholder={maskedPlaceholder}
                        className="flex-1"
                        {...field}
                      />
                    </FormControl>
                    {validationStatus === "error" && !loading && (
                      <CircleX
                        className="size-5 text-destructive shrink-0"
                        data-testid="key-error-indicator"
                      />
                    )}
                    {validationStatus !== "error" &&
                      (isConfigured || validationStatus === "success") &&
                      !loading && (
                        <CircleCheck
                          className="size-5 text-green-600 shrink-0"
                          data-testid="key-configured-indicator"
                        />
                      )}
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    {isUrlProvider ? (
                      <>
                        <Globe className="size-3" />
                        Your URL is stored on your server. No data is sent to external services.
                      </>
                    ) : (
                      <>
                        <Lock className="size-3" />
                        Your API key is encrypted at rest and never leaves your server.
                      </>
                    )}
                  </p>
                </FormItem>
              )}
            />

            {error && (
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm text-destructive">{error}</p>
                  {errorDocs && (
                    <a
                      href={errorDocs.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary-accent hover:underline"
                    >
                      {errorDocs.label}
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <ReportIssueLink error={error} />
              </div>
            )}

            <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ChevronDown
                  className={`size-4 transition-transform ${guideOpen ? "rotate-180" : ""}`}
                />
                {isUrlProvider ? "Need help setting up?" : "Need help getting a key?"}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 space-y-3 rounded-md border p-3 text-sm">
                  <ol className="space-y-1.5 list-decimal list-inside text-muted-foreground">
                    {PROVIDERS[provider].guide.steps.map((step) => (
                      <li key={step.label}>
                        {step.link ? renderStepWithLink(step.label, step.link) : step.label}
                        {step.optional && (
                          <span className="text-xs text-muted-foreground/60"> (optional)</span>
                        )}
                      </li>
                    ))}
                  </ol>
                  <a
                    href={PROVIDERS[provider].guide.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary-accent hover:underline"
                  >
                    {isUrlProvider ? "Setup guide" : `Go to ${PROVIDERS[provider].name}`}
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <Button type="submit" disabled={!apiKeyValue.trim() || loading} className="w-full">
              {loading ? "Validating..." : configuredProviders ? "Save & restart" : submitLabel}
            </Button>
            {configuredProviders && (
              <p className="text-xs text-muted-foreground text-center">
                Saving will briefly restart the agent runtime.
              </p>
            )}

            {manageCustomProviders && isConfigured && defaultProvider !== provider && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={settingDefault}
                onClick={() => handleSetDefault(provider!)}
              >
                <Star className="size-4 fill-muted-foreground text-muted-foreground" />
                {settingDefault ? "Setting as default..." : "Set as default"}
              </Button>
            )}

            {configuredProviders && isConfigured && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full text-destructive hover:text-destructive"
                    disabled={removing}
                  >
                    {removing ? "Removing..." : isUrlProvider ? "Remove URL" : "Remove key"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {isUrlProvider ? "Remove URL?" : "Remove API key?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove your {provider ? PROVIDERS[provider].name : ""}{" "}
                      {isUrlProvider ? "URL" : "API key"}. If this is the active provider, agents
                      will be switched to another configured provider.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={async () => {
                        setRemoving(true);
                        try {
                          const res = await fetch("/api/settings/providers", {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ provider }),
                          });
                          if (!res.ok) {
                            const data = await res.json();
                            throw new Error(data.error || "Failed to remove key");
                          }
                          triggerRestart();
                          onSuccess(provider!);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed to remove key");
                        } finally {
                          setRemoving(false);
                        }
                      }}
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </>
        )}
      </form>
    </Form>
  );
}
