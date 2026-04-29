"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import {
  normalizeOdooUrl,
  parseOdooSubdomainHint,
  generateConnectionName,
} from "@/lib/integrations/odoo-url";
import { Loader2, CheckCircle2, AlertTriangle, Copy, Check } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { OdooIcon, PipedriveIcon, GoogleIcon, BraveIcon } from "./integration-icons";
import { docsUrl } from "./docs-link";

interface IntegrationType {
  id: string;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const INTEGRATION_TYPES: IntegrationType[] = [
  {
    id: "odoo",
    name: "Odoo",
    description: "Connect your Odoo ERP to query sales, inventory, and customer data.",
    icon: OdooIcon,
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    description: "Connect your Pipedrive CRM to manage deals, contacts, and pipeline data.",
    icon: PipedriveIcon,
  },
  {
    id: "google",
    name: "Google",
    description: "Connect your Google account to sync email via Gmail.",
    icon: GoogleIcon,
  },
  {
    id: "web-search",
    name: "Web Search (Brave)",
    description: "Search the web and fetch pages via Brave Search API.",
    icon: BraveIcon,
  },
];

// --- Wizard state ---

type WizardStep = "type" | "connect" | "sync" | "done";

// --- Connect form schemas ---

const odooConnectFormSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  login: z.string().min(1, "Email is required"),
  apiKey: z.string().min(1, "API key is required"),
  db: z.string().min(1, "Database is required"),
});

type OdooConnectFormValues = z.infer<typeof odooConnectFormSchema>;

const pipedriveConnectFormSchema = z.object({
  apiToken: z.string().min(1, "API token is required"),
});

type PipedriveConnectFormValues = z.infer<typeof pipedriveConnectFormSchema>;

const webSearchFormSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});

type WebSearchFormValues = z.infer<typeof webSearchFormSchema>;

// --- Step indicator ---

function StepIndicator({
  current,
  total,
  label,
}: {
  current: number;
  total: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
      <span>
        Step {current} of {total}
      </span>
      <span>&mdash;</span>
      <span>{label}</span>
    </div>
  );
}

// --- Sync category result (generic across integration types) ---

interface SyncCategoryResult {
  id: string;
  label: string;
  accessible: boolean;
  accessibleItems: string[];
  totalItems: number;
}

// --- Google Connect Step ---

type GoogleOAuthStatus = "loading" | "not-configured" | "configured";

function GoogleConnectStep({
  isSecure,
  onBack,
  onCancel,
}: {
  isSecure: boolean;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [oauthStatus, setOauthStatus] = useState<GoogleOAuthStatus>("loading");
  const [justConfigured, setJustConfigured] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { isCopied, copy } = useCopyToClipboard();

  useEffect(() => {
    if (!isSecure) return;
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/settings/oauth?provider=google");
        const data = await res.json();
        if (!cancelled) setOauthStatus(data.configured ? "configured" : "not-configured");
      } catch {
        if (!cancelled) setOauthStatus("not-configured");
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [isSecure]);

  async function handleSaveOAuth() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveError(data.error || "Failed to save OAuth credentials");
        setSaving(false);
        return;
      }
      setJustConfigured(true);
      setOauthStatus("configured");
      setSaving(false);
    } catch {
      setSaveError("Failed to save OAuth credentials");
      setSaving(false);
    }
  }

  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/integrations/oauth/callback`
      : "/api/integrations/oauth/callback";

  // Not HTTPS — show warning
  if (!isSecure) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium text-amber-800 dark:text-amber-200">HTTPS is required</p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Google OAuth requires a secure HTTPS connection. See{" "}
              <a
                href={docsUrl("guides/domain-lock")}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                Lock Pinchy to a Domain
              </a>{" "}
              to enable HTTPS.
            </p>
          </div>
        </div>

        <div className="flex justify-between pt-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Loading
  if (oauthStatus === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Checking OAuth configuration...</p>
      </div>
    );
  }

  // Not configured — show inline setup form
  if (oauthStatus === "not-configured") {
    return (
      <div className="space-y-5">
        <StepIndicator current={1} total={2} label="Set up Google OAuth" />

        {/* Section 1: Copy redirect URI TO Google */}
        <div className="space-y-2">
          <p className="text-sm font-medium">1. Copy this redirect URI to Google Cloud Console</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 text-xs break-all">
              {redirectUrl}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => {
                copy(redirectUrl);
                toast.success("Copied to clipboard");
              }}
            >
              {isCopied ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Open{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Google Cloud Console → Credentials
            </a>
            , create a <span className="font-medium">Web application</span> OAuth client, and add
            this URI under <span className="font-medium">Authorized redirect URIs</span>.{" "}
            <a
              href={docsUrl("guides/connect-email")}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Full guide
            </a>
          </p>
          <p className="text-xs text-muted-foreground italic">
            Keep this page open — you&apos;ll need to come back.
          </p>
        </div>

        {/* Section 2: Paste credentials FROM Google */}
        <div className="space-y-3">
          <p className="text-sm font-medium">2. Paste your credentials from Google</p>
          <div className="space-y-2">
            <Label htmlFor="google-client-id">Client ID</Label>
            <Input
              id="google-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="google-client-secret">Client Secret</Label>
            <Input
              id="google-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-..."
            />
          </div>
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <div className="flex justify-between pt-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!clientId.trim() || !clientSecret.trim() || saving}
              onClick={handleSaveOAuth}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save & Continue"
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Configured — show connect button
  return (
    <div className="space-y-4">
      <StepIndicator
        current={justConfigured ? 2 : 1}
        total={justConfigured ? 2 : 1}
        label="Connect"
      />

      {/* eslint-disable @next/next/no-html-link-for-pages -- OAuth requires full page redirect */}
      <div className="flex flex-col items-center gap-4 py-4">
        <a
          href="/api/integrations/oauth/start"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Connect Google Account
        </a>
      </div>
      {/* eslint-enable @next/next/no-html-link-for-pages */}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// --- Dialog component ---

interface AddIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  existingTypes?: string[];
  initialType?: "google";
}

export function AddIntegrationDialog({
  open,
  onOpenChange,
  onSuccess,
  existingTypes = [],
  initialType,
}: AddIntegrationDialogProps) {
  // Types that only allow one connection (singletons)
  const singletonTypes = new Set(["web-search"]);
  const [step, setStep] = useState<WizardStep>(initialType ? "connect" : "type");
  const [selectedType, setSelectedType] = useState<string | null>(initialType ?? null);

  // Connect step results
  const [connectionResult, setConnectionResult] = useState<{
    uid?: number;
    version?: string;
    companyDomain?: string;
    companyName?: string;
    userId?: number;
    userName?: string;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Sync step results
  const [syncResult, setSyncResult] = useState<{
    models?: number;
    entities?: number;
    categories: SyncCategoryResult[];
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncData, setSyncData] = useState<unknown>(null);

  // Done step
  const [connectionName, setConnectionName] = useState("");

  // DB detection (Odoo-specific)
  const [dbFetchState, setDbFetchState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [fetchedDatabases, setFetchedDatabases] = useState<string[]>([]);

  const isSecure = typeof window !== "undefined" && window.location.protocol === "https:";

  const odooForm = useForm<OdooConnectFormValues>({
    resolver: zodResolver(odooConnectFormSchema),
    defaultValues: {
      url: "",
      login: "",
      apiKey: "",
      db: "",
    },
  });

  const pipedriveForm = useForm<PipedriveConnectFormValues>({
    resolver: zodResolver(pipedriveConnectFormSchema),
    defaultValues: {
      apiToken: "",
    },
  });

  const webSearchForm = useForm<WebSearchFormValues>({
    resolver: zodResolver(webSearchFormSchema),
    defaultValues: {
      apiKey: "",
    },
  });

  function resetAll() {
    setStep(initialType ? "connect" : "type");
    setSelectedType(initialType ?? null);
    setConnectionResult(null);
    setConnecting(false);
    setSyncResult(null);
    setSyncError(null);
    setSyncData(null);
    setSaving(false);
    setConnectionName("");
    setDbFetchState("idle");
    setFetchedDatabases([]);
    odooForm.reset();
    pipedriveForm.reset();
    webSearchForm.reset();
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) {
      resetAll();
    }
    onOpenChange(isOpen);
  }

  function handleBack() {
    if (step === "connect") {
      if (initialType) {
        // No type-selection step to go back to — close the dialog instead
        onOpenChange(false);
        return;
      }
      setSelectedType(null);
      setConnectionResult(null);
      setConnecting(false);
      setDbFetchState("idle");
      setFetchedDatabases([]);
      odooForm.reset();
      pipedriveForm.reset();
      webSearchForm.reset();
      setStep("type");
    }
  }

  // --- URL blur: fetch databases (Odoo-specific) ---

  async function handleUrlBlur(raw: string) {
    const url = normalizeOdooUrl(raw);
    if (!url) return;

    if (url !== raw) {
      odooForm.setValue("url", url);
    }

    setDbFetchState("loading");
    setFetchedDatabases([]);

    try {
      const res = await fetch("/api/integrations/list-databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();

      if (data.success && Array.isArray(data.databases) && data.databases.length > 0) {
        setFetchedDatabases(data.databases);
        setDbFetchState("done");

        const hint = parseOdooSubdomainHint(url);
        if (hint && data.databases.includes(hint)) {
          odooForm.setValue("db", hint);
        } else if (data.databases.length === 1) {
          odooForm.setValue("db", data.databases[0]);
        }
      } else {
        setDbFetchState("failed");
      }
    } catch {
      setDbFetchState("failed");
    }
  }

  // --- Step 1: Connect (Odoo) ---

  async function onOdooConnect(values: OdooConnectFormValues) {
    odooForm.clearErrors("root");
    setConnecting(true);

    try {
      const testRes = await fetch("/api/integrations/test-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: values.url,
            db: values.db,
            login: values.login,
            apiKey: values.apiKey,
          },
        }),
      });

      const testData = await testRes.json();

      if (!testRes.ok || !testData.success) {
        odooForm.setError("root", {
          message: testData.error || "Connection test failed",
        });
        setConnecting(false);
        return;
      }

      setConnectionResult({ uid: testData.uid, version: testData.version });
      setConnecting(false);
      setStep("sync");
      runOdooSyncPreview(testData.uid);
    } catch {
      odooForm.setError("root", { message: "Connection test failed" });
      setConnecting(false);
    }
  }

  // --- Step 1: Connect (Pipedrive) ---

  async function onPipedriveConnect(values: PipedriveConnectFormValues) {
    pipedriveForm.clearErrors("root");
    setConnecting(true);

    try {
      const testRes = await fetch("/api/integrations/test-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "pipedrive",
          credentials: { apiToken: values.apiToken },
        }),
      });

      const testData = await testRes.json();

      if (!testRes.ok || !testData.success) {
        pipedriveForm.setError("root", {
          message: testData.error || "Connection test failed",
        });
        setConnecting(false);
        return;
      }

      setConnectionResult({
        companyDomain: testData.companyDomain,
        companyName: testData.companyName,
        userId: testData.userId,
        userName: testData.userName,
      });
      setConnecting(false);
      setStep("sync");
      runPipedriveSyncPreview(values.apiToken);
    } catch {
      pipedriveForm.setError("root", { message: "Connection test failed" });
      setConnecting(false);
    }
  }

  // --- Step 2: Sync Preview (Odoo) ---

  async function runOdooSyncPreview(uid: number) {
    setSyncError(null);

    try {
      const values = odooForm.getValues();

      const res = await fetch("/api/integrations/sync-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: values.url,
            db: values.db,
            login: values.login,
            apiKey: values.apiKey,
            uid,
          },
        }),
      });

      const data = await res.json();

      if (data.success) {
        const categories: SyncCategoryResult[] = (data.categories ?? []).map(
          (cat: {
            id: string;
            label: string;
            accessible: boolean;
            accessibleModels: string[];
            totalModels: number;
          }) => ({
            id: cat.id,
            label: cat.label,
            accessible: cat.accessible,
            accessibleItems: cat.accessibleModels,
            totalItems: cat.totalModels,
          })
        );
        setSyncResult({ models: data.models, categories });
        setSyncData(data.data);
      } else {
        setSyncError(data.error || "Schema sync failed");
      }
    } catch {
      setSyncError("Schema sync failed");
    }
  }

  // --- Step 2: Sync Preview (Pipedrive) ---

  async function runPipedriveSyncPreview(apiToken: string) {
    setSyncError(null);

    try {
      const res = await fetch("/api/integrations/sync-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "pipedrive",
          credentials: { apiToken },
        }),
      });

      const data = await res.json();

      if (data.success) {
        const categories: SyncCategoryResult[] = (data.categories ?? []).map(
          (cat: {
            id: string;
            label: string;
            accessible: boolean;
            accessibleEntities: string[];
            totalEntities: number;
          }) => ({
            id: cat.id,
            label: cat.label,
            accessible: cat.accessible,
            accessibleItems: cat.accessibleEntities,
            totalItems: cat.totalEntities,
          })
        );
        setSyncResult({ entities: data.entities, categories });
        setSyncData(data.data);
      } else {
        setSyncError(data.error || "Schema sync failed");
      }
    } catch {
      setSyncError("Schema sync failed");
    }
  }

  // --- Step 3: Done (creates the integration with all data at once) ---

  const [saving, setSaving] = useState(false);

  async function handleDone() {
    setSaving(true);
    try {
      let credentials: unknown;

      if (selectedType === "pipedrive") {
        const values = pipedriveForm.getValues();
        credentials = {
          apiToken: values.apiToken,
          companyDomain: connectionResult?.companyDomain,
          companyName: connectionResult?.companyName,
          userId: connectionResult?.userId,
          userName: connectionResult?.userName,
        };
      } else {
        const values = odooForm.getValues();
        credentials = {
          url: values.url,
          db: values.db,
          login: values.login,
          apiKey: values.apiKey,
          uid: connectionResult?.uid,
        };
      }

      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          name: connectionName,
          description: "",
          credentials,
          data: syncData,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to save integration");
        setSaving(false);
        return;
      }

      toast.success("Integration ready");
      handleClose(false);
      onSuccess();
    } catch {
      toast.error("Failed to save integration");
      setSaving(false);
    }
  }

  // --- Web Search: Test & Save (single step) ---

  async function onWebSearchTestAndSave(values: WebSearchFormValues) {
    webSearchForm.clearErrors("root");
    setConnecting(true);

    try {
      // 1. Test the API key
      const testRes = await fetch("/api/integrations/test-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "web-search",
          credentials: { apiKey: values.apiKey },
        }),
      });

      const testData = await testRes.json();

      if (!testRes.ok || !testData.success) {
        webSearchForm.setError("root", {
          message: testData.error || "API key validation failed",
        });
        setConnecting(false);
        return;
      }

      // 2. Create the integration immediately
      const createRes = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "web-search",
          name: "Brave Search",
          description: "",
          credentials: { apiKey: values.apiKey },
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json();
        webSearchForm.setError("root", {
          message: err.error || "Failed to save integration",
        });
        setConnecting(false);
        return;
      }

      toast.success("Web Search connected");
      handleClose(false);
      onSuccess();
    } catch {
      webSearchForm.setError("root", { message: "Connection failed" });
      setConnecting(false);
    }
  }

  // --- Permission error detection (Odoo-specific) ---
  const isPermissionError =
    selectedType === "odoo" &&
    syncError &&
    (syncError.includes("ir.model") ||
      syncError.includes("Access") ||
      syncError.includes("permission"));

  const typeName = INTEGRATION_TYPES.find((t) => t.id === selectedType)?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        {/* Step 0: Type Selection */}
        {step === "type" && (
          <>
            <DialogHeader>
              <DialogTitle>Add Integration</DialogTitle>
              <DialogDescription>
                Choose an integration type to connect an external system.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 pt-2">
              {INTEGRATION_TYPES.map((type) => {
                const Icon = type.icon;
                const alreadyExists =
                  singletonTypes.has(type.id) && existingTypes.includes(type.id);
                return (
                  <button
                    key={type.id}
                    disabled={alreadyExists}
                    onClick={() => {
                      setSelectedType(type.id);
                      setStep("connect");
                    }}
                    className="flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Icon className="h-8 w-16 shrink-0" />
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{type.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {alreadyExists ? "Already configured" : type.description}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Step 1: Connect (Web Search — simplified single-step) */}
        {step === "connect" && selectedType === "web-search" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect Web Search (Brave)</DialogTitle>
              <DialogDescription>
                Enter your Brave Search API key to enable web search for agents.
              </DialogDescription>
            </DialogHeader>

            <Form {...webSearchForm}>
              <form
                onSubmit={webSearchForm.handleSubmit(onWebSearchTestAndSave)}
                className="space-y-4"
              >
                <FormField
                  control={webSearchForm.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Key</FormLabel>
                      <FormControl>
                        <PasswordInput placeholder="BSA..." {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {webSearchForm.formState.errors.root && (
                  <p className="text-sm text-destructive">
                    {webSearchForm.formState.errors.root.message}
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  Get your API key from{" "}
                  <a
                    href="https://brave.com/search/api/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 hover:text-foreground"
                  >
                    brave.com/search/api
                  </a>
                </p>

                <div className="flex justify-between pt-2">
                  <Button type="button" variant="ghost" onClick={handleBack}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={connecting}>
                      {connecting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        "Test & Save"
                      )}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </>
        )}

        {/* Step 1: Connect (Odoo) */}
        {step === "connect" && selectedType === "odoo" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {typeName}</DialogTitle>
              <DialogDescription>
                Enter the connection details for your {typeName} instance.
              </DialogDescription>
            </DialogHeader>

            <StepIndicator current={1} total={3} label="Connect" />

            <Form {...odooForm}>
              <form onSubmit={odooForm.handleSubmit(onOdooConnect)} className="space-y-4">
                <FormField
                  control={odooForm.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>URL</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://odoo.example.com"
                          {...field}
                          onBlur={(e) => {
                            field.onBlur();
                            if (e.target.value) {
                              handleUrlBlur(e.target.value);
                            }
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={odooForm.control}
                  name="login"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input placeholder="admin@example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={odooForm.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Key</FormLabel>
                      <PasswordInput placeholder="Your API key" {...field} />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Database field: hidden by default, shown when multiple DBs found or fetch failed */}
                {dbFetchState === "failed" && (
                  <FormField
                    control={odooForm.control}
                    name="db"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Database</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="e.g. production"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {dbFetchState === "done" && fetchedDatabases.length > 1 && (
                  <FormField
                    control={odooForm.control}
                    name="db"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Database</FormLabel>
                        <FormControl>
                          <Select
                            value={field.value}
                            onValueChange={(value) => field.onChange(value)}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select a database" />
                            </SelectTrigger>
                            <SelectContent>
                              {fetchedDatabases.map((db) => (
                                <SelectItem key={db} value={db}>
                                  {db}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {odooForm.formState.errors.root && (
                  <p className="text-sm text-destructive">
                    {odooForm.formState.errors.root.message}
                  </p>
                )}

                <div className="flex justify-between pt-2">
                  <Button type="button" variant="ghost" onClick={handleBack}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={connecting}>
                      {connecting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        "Connect"
                      )}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </>
        )}

        {/* Step 1: Connect (Pipedrive) */}
        {step === "connect" && selectedType === "pipedrive" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {typeName}</DialogTitle>
              <DialogDescription>
                Enter the connection details for your {typeName} instance.
              </DialogDescription>
            </DialogHeader>

            <StepIndicator current={1} total={3} label="Connect" />

            <Form {...pipedriveForm}>
              <form onSubmit={pipedriveForm.handleSubmit(onPipedriveConnect)} className="space-y-4">
                <FormField
                  control={pipedriveForm.control}
                  name="apiToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Token</FormLabel>
                      <PasswordInput placeholder="Your Pipedrive API token" {...field} />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {pipedriveForm.formState.errors.root && (
                  <p className="text-sm text-destructive">
                    {pipedriveForm.formState.errors.root.message}
                  </p>
                )}

                <div className="flex justify-between pt-2">
                  <Button type="button" variant="ghost" onClick={handleBack}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={connecting}>
                      {connecting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        "Connect"
                      )}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </>
        )}

        {/* Step 1: Connect (Google OAuth) */}
        {step === "connect" && selectedType === "google" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect Google</DialogTitle>
              <DialogDescription>
                Sign in with your Google account to connect Gmail.
              </DialogDescription>
            </DialogHeader>

            <GoogleConnectStep
              isSecure={isSecure}
              onBack={handleBack}
              onCancel={() => handleClose(false)}
            />
          </>
        )}

        {/* Step 2: Sync Schema — shows loading, then results with category list */}
        {step === "sync" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {typeName}</DialogTitle>
              <DialogDescription>
                {syncResult
                  ? "Here\u2019s what your agents can access."
                  : `Checking which data your ${typeName} user can access\u2026`}
              </DialogDescription>
            </DialogHeader>

            <StepIndicator current={2} total={3} label="Available Data" />

            <div className="space-y-4">
              {/* Loading */}
              {!syncError && !syncResult && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Syncing data from {typeName}...</p>
                </div>
              )}

              {/* Success — category grid */}
              {syncResult?.categories && (
                <>
                  <div className="max-h-56 overflow-y-auto rounded-lg border">
                    <div className="grid grid-cols-[1.5rem_6rem_1fr] gap-x-3">
                      {syncResult.categories
                        .filter((cat) => cat.accessible)
                        .map((cat) => (
                          <div
                            key={cat.id}
                            className="col-span-3 grid grid-cols-subgrid items-first-baseline border-b px-3 py-2 last:border-b-0"
                          >
                            <CheckCircle2 className="h-4 w-4 translate-y-[1px] text-green-600 dark:text-green-400" />
                            <span className="text-sm font-medium">{cat.label}</span>
                            <span className="text-xs leading-5 text-muted-foreground">
                              {cat.accessibleItems.join(", ")}
                            </span>
                          </div>
                        ))}
                      {syncResult.categories
                        .filter((cat) => !cat.accessible)
                        .map((cat) => (
                          <div
                            key={cat.id}
                            className="col-span-3 grid grid-cols-subgrid items-center border-b px-3 py-2 opacity-40 last:border-b-0"
                          >
                            <span className="text-center text-xs text-muted-foreground">
                              &mdash;
                            </span>
                            <span className="text-sm text-muted-foreground">{cat.label}</span>
                            <span className="text-xs text-muted-foreground">No access</span>
                          </div>
                        ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    These are the data types available to this connection. You can control which
                    data each agent can access in the agent&apos;s settings.
                  </p>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => {
                        if (selectedType === "pipedrive") {
                          setConnectionName(
                            connectionResult?.companyName
                              ? `${connectionResult.companyName} Pipedrive`
                              : "Pipedrive"
                          );
                        } else {
                          setConnectionName(generateConnectionName(odooForm.getValues().url));
                        }
                        setStep("done");
                      }}
                    >
                      Continue
                    </Button>
                  </div>
                </>
              )}

              {/* Permission error (Odoo-specific) */}
              {syncError && isPermissionError && (
                <>
                  <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div className="space-y-2">
                      <p className="font-medium text-amber-800 dark:text-amber-200">
                        Permission Error
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        Your Odoo user needs module access rights to sync data.
                      </p>
                      <div className="text-sm text-amber-700 dark:text-amber-300">
                        <p className="font-medium">How to fix:</p>
                        <ol className="mt-1 list-decimal pl-5 space-y-1">
                          <li>In Odoo, go to Settings &rarr; Users &amp; Companies &rarr; Users</li>
                          <li>Select the API user ({odooForm.getValues().login})</li>
                          <li>
                            On the &quot;Access Rights&quot; tab, enable the modules you need (e.g.
                            Sales, Inventory, Contacts)
                          </li>
                          <li>Come back here and click &quot;Retry&quot;</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => {
                        if (!connectionResult?.uid) return;
                        setSyncError(null);
                        runOdooSyncPreview(connectionResult.uid);
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                </>
              )}

              {/* Generic error */}
              {syncError && !isPermissionError && (
                <>
                  <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <div className="space-y-1">
                      <p className="font-medium text-destructive">Sync failed</p>
                      <p className="text-sm text-muted-foreground">{syncError}</p>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => {
                        setSyncError(null);
                        if (selectedType === "pipedrive") {
                          runPipedriveSyncPreview(pipedriveForm.getValues().apiToken);
                        } else if (connectionResult?.uid) {
                          runOdooSyncPreview(connectionResult.uid);
                        }
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* Step 3: Name & Save */}
        {step === "done" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {typeName}</DialogTitle>
              <DialogDescription>Almost done — give your integration a name.</DialogDescription>
            </DialogHeader>

            <StepIndicator current={3} total={3} label="Save" />

            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="connection-name" className="text-sm font-medium">
                  Name this integration
                </label>
                <Input
                  id="connection-name"
                  value={connectionName}
                  onChange={(e) => setConnectionName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This name helps you and your agents identify the connection.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleDone} disabled={!connectionName.trim() || saving}>
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
