"use client";

import { useState } from "react";
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
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { OdooIcon } from "./integration-icons";

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
  // Future: { id: "shopify", name: "Shopify", description: "...", icon: ShopifyIcon },
];

// --- Wizard state ---

type WizardStep = "type" | "connect" | "sync" | "done";

// --- Connect form schema (no name/description — auto-generated) ---

const connectFormSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  login: z.string().min(1, "Email is required"),
  apiKey: z.string().min(1, "API key is required"),
  db: z.string().min(1, "Database is required"),
});

type ConnectFormValues = z.infer<typeof connectFormSchema>;

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

// --- Dialog component ---

interface AddIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AddIntegrationDialog({ open, onOpenChange, onSuccess }: AddIntegrationDialogProps) {
  const [step, setStep] = useState<WizardStep>("type");
  const [selectedType, setSelectedType] = useState<string | null>(null);

  // Connect step results
  const [connectionResult, setConnectionResult] = useState<{
    uid: number;
    version: string;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Sync step results
  const [syncResult, setSyncResult] = useState<{
    models: number;
    categories: Array<{
      id: string;
      label: string;
      accessible: boolean;
      accessibleModels: string[];
      totalModels: number;
    }>;
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncData, setSyncData] = useState<unknown>(null);

  // Done step
  const [connectionName, setConnectionName] = useState("");

  // DB detection
  const [dbFetchState, setDbFetchState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [fetchedDatabases, setFetchedDatabases] = useState<string[]>([]);

  const form = useForm<ConnectFormValues>({
    resolver: zodResolver(connectFormSchema),
    defaultValues: {
      url: "",
      login: "",
      apiKey: "",
      db: "",
    },
  });

  function resetAll() {
    setStep("type");
    setSelectedType(null);
    setConnectionResult(null);
    setConnecting(false);
    setSyncResult(null);
    setSyncError(null);
    setSyncData(null);
    setSaving(false);
    setConnectionName("");
    setDbFetchState("idle");
    setFetchedDatabases([]);
    form.reset();
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) {
      resetAll();
    }
    onOpenChange(isOpen);
  }

  function handleBack() {
    if (step === "connect") {
      setSelectedType(null);
      setConnectionResult(null);
      setConnecting(false);
      setDbFetchState("idle");
      setFetchedDatabases([]);
      form.reset();
      setStep("type");
    }
  }

  // --- URL blur: fetch databases ---

  async function handleUrlBlur(raw: string) {
    const url = normalizeOdooUrl(raw);
    if (!url) return;

    if (url !== raw) {
      form.setValue("url", url);
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
          form.setValue("db", hint);
        } else if (data.databases.length === 1) {
          form.setValue("db", data.databases[0]);
        }
      } else {
        setDbFetchState("failed");
      }
    } catch {
      setDbFetchState("failed");
    }
  }

  // --- Step 1: Connect ---

  async function onConnect(values: ConnectFormValues) {
    form.clearErrors("root");
    setConnecting(true);

    try {
      const testRes = await fetch("/api/integrations/test-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
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
        form.setError("root", {
          message: testData.error || "Connection test failed",
        });
        setConnecting(false);
        return;
      }

      setConnectionResult({ uid: testData.uid, version: testData.version });
      setConnecting(false);
      setStep("sync");
      // Trigger sync immediately — no useEffect needed
      runSyncPreview(testData.uid);
    } catch {
      form.setError("root", { message: "Connection test failed" });
      setConnecting(false);
    }
  }

  // --- Step 2: Sync (preview only — nothing saved yet) ---

  async function runSyncPreview(uid: number) {
    setSyncError(null);

    try {
      const values = form.getValues();

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
        setSyncResult({ models: data.models, categories: data.categories ?? [] });
        setSyncData(data.data);
        // Stay on sync step — user clicks "Continue" to proceed
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
      const values = form.getValues();

      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          name: connectionName,
          description: "",
          credentials: {
            url: values.url,
            db: values.db,
            login: values.login,
            apiKey: values.apiKey,
            uid: connectionResult?.uid,
          },
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

  // --- Permission error detection ---
  const isPermissionError =
    syncError &&
    (syncError.includes("ir.model") ||
      syncError.includes("Access") ||
      syncError.includes("permission"));

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
                return (
                  <button
                    key={type.id}
                    onClick={() => {
                      setSelectedType(type.id);
                      setStep("connect");
                    }}
                    className="flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
                  >
                    <Icon className="h-8 w-16 shrink-0" />
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{type.name}</span>
                      <span className="text-sm text-muted-foreground">{type.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Step 1: Connect */}
        {step === "connect" && (
          <>
            <DialogHeader>
              <DialogTitle>
                Connect {INTEGRATION_TYPES.find((t) => t.id === selectedType)?.name}
              </DialogTitle>
              <DialogDescription>
                Enter the connection details for your{" "}
                {INTEGRATION_TYPES.find((t) => t.id === selectedType)?.name} instance.
              </DialogDescription>
            </DialogHeader>

            <StepIndicator current={1} total={3} label="Connect" />

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onConnect)} className="space-y-4">
                <FormField
                  control={form.control}
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
                  control={form.control}
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
                  control={form.control}
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
                    control={form.control}
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
                    control={form.control}
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

                {form.formState.errors.root && (
                  <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
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

        {/* Step 2: Sync Schema — shows loading, then results with category list */}
        {step === "sync" && (
          <>
            <DialogHeader>
              <DialogTitle>
                Connect {INTEGRATION_TYPES.find((t) => t.id === selectedType)?.name}
              </DialogTitle>
              <DialogDescription>
                {syncResult
                  ? "Here\u2019s what your agents can access."
                  : "Checking which data your Odoo user can access\u2026"}
              </DialogDescription>
            </DialogHeader>

            <StepIndicator current={2} total={3} label="Available Data" />

            <div className="space-y-4">
              {/* Loading */}
              {!syncError && !syncResult && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Syncing models from Odoo...</p>
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
                              {cat.accessibleModels.join(", ")}
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
                        setConnectionName(generateConnectionName(form.getValues().url));
                        setStep("done");
                      }}
                    >
                      Continue
                    </Button>
                  </div>
                </>
              )}

              {/* Permission error */}
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
                          <li>Select the API user ({form.getValues().login})</li>
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
                        if (!connectionResult) return;
                        setSyncError(null);
                        runSyncPreview(connectionResult.uid);
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
                        if (!connectionResult) return;
                        setSyncError(null);
                        runSyncPreview(connectionResult.uid);
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
              <DialogTitle>
                Connect {INTEGRATION_TYPES.find((t) => t.id === selectedType)?.name}
              </DialogTitle>
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
