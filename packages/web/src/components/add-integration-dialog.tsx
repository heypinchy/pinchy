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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

// --- Integration type registry (extend here for future integrations) ---

function OdooIcon({ className }: { className?: string }) {
  // currentColor adapts to dark/light mode. Inner circles are transparent (cut-out effect).
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 191" className={className}>
      <mask id="odoo-holes">
        <rect width="600" height="191" fill="white" />
        <circle cx="527.5" cy="118.4" r="42.7" fill="black" />
        <circle cx="374" cy="118.4" r="42.7" fill="black" />
        <circle cx="222.5" cy="118.4" r="42.7" fill="black" />
        <circle cx="71.7" cy="118.5" r="42.7" fill="black" />
      </mask>
      <g mask="url(#odoo-holes)" fill="currentColor">
        <circle cx="527.5" cy="118.4" r="72.4" />
        <circle cx="374" cy="118.4" r="72.4" />
        <path d="M294.9 117.8v.6c0 40-32.4 72.4-72.4 72.4s-72.4-32.4-72.4-72.4S182.5 46 222.5 46c16.4 0 31.5 5.5 43.7 14.6V14.4A14.34 14.34 0 0 1 280.6 0c7.9 0 14.4 6.5 14.4 14.4v102.7c0 .2 0 .5-.1.7z" />
        <circle cx="72.4" cy="118.2" r="72.4" />
      </g>
    </svg>
  );
}

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

// --- Odoo credentials form ---

const odooFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500),
  url: z.string().url("Must be a valid URL"),
  db: z.string().min(1, "Database name is required"),
  login: z.string().min(1, "Login is required"),
  apiKey: z.string().min(1, "API key is required"),
});

type OdooFormValues = z.infer<typeof odooFormSchema>;

// --- Dialog component ---

interface AddIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AddIntegrationDialog({ open, onOpenChange, onSuccess }: AddIntegrationDialogProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const form = useForm<OdooFormValues>({
    resolver: zodResolver(odooFormSchema),
    defaultValues: {
      name: "",
      description: "",
      url: "",
      db: "",
      login: "",
      apiKey: "",
    },
  });

  function handleClose(isOpen: boolean) {
    if (!isOpen) {
      setSelectedType(null);
      form.reset();
      setDbFetchState("idle");
      setFetchedDatabases([]);
    }
    onOpenChange(isOpen);
  }

  function handleBack() {
    setSelectedType(null);
    form.reset();
    setDbFetchState("idle");
    setFetchedDatabases([]);
  }

  const [submitPhase, setSubmitPhase] = useState<"idle" | "testing" | "creating">("idle");
  const [dbFetchState, setDbFetchState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [fetchedDatabases, setFetchedDatabases] = useState<string[]>([]);

  function normalizeOdooUrl(raw: string): string | null {
    try {
      const parsed = new URL(raw);
      // Strip path — only keep origin (protocol + host)
      return parsed.origin;
    } catch {
      return null;
    }
  }

  function parseSubdomainHint(url: string): string | null {
    try {
      const hostname = new URL(url).hostname;
      // Match *.odoo.com or *.dev.odoo.com
      const odooMatch = hostname.match(/^([^.]+)\.(?:dev\.)?odoo\.com$/);
      return odooMatch ? odooMatch[1] : null;
    } catch {
      return null;
    }
  }

  async function handleUrlBlur(raw: string) {
    const url = normalizeOdooUrl(raw);
    if (!url) return;

    // Update the form field to the normalized URL
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

        // Auto-select if subdomain matches one of the databases
        const hint = parseSubdomainHint(url);
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

  async function onSubmit(values: OdooFormValues) {
    form.clearErrors("root");

    try {
      // Phase 1: Test credentials
      setSubmitPhase("testing");
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

      if (!testRes.ok) {
        form.setError("root", { message: testData.error || "Connection test failed" });
        setSubmitPhase("idle");
        return;
      }

      if (!testData.success) {
        form.setError("root", { message: testData.error || "Connection test failed" });
        setSubmitPhase("idle");
        return;
      }

      // Phase 2: Create integration with the real uid from test
      setSubmitPhase("creating");
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          name: values.name,
          description: values.description,
          credentials: {
            url: values.url,
            db: values.db,
            login: values.login,
            apiKey: values.apiKey,
            uid: testData.uid,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        form.setError("root", { message: data.error || "Failed to create integration" });
        setSubmitPhase("idle");
        return;
      }

      toast.success("Integration created successfully");
      form.reset();
      setSelectedType(null);
      setSubmitPhase("idle");
      onSuccess();
    } catch {
      form.setError("root", { message: "Failed to create integration" });
      setSubmitPhase("idle");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        {!selectedType ? (
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
                    onClick={() => setSelectedType(type.id)}
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
        ) : (
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

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Production Odoo" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="What is this integration used for?"
                          className="resize-none"
                          rows={2}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
                      <FormLabel>Login</FormLabel>
                      <FormControl>
                        <Input placeholder="admin" {...field} />
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
                      <FormControl>
                        <Input type="password" placeholder="Your API key" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="db"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Database</FormLabel>
                      <FormControl>
                        {dbFetchState === "done" && fetchedDatabases.length > 0 ? (
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
                        ) : (
                          <Input
                            placeholder={
                              dbFetchState === "loading" ? "Loading databases..." : "production"
                            }
                            disabled={dbFetchState === "loading"}
                            {...field}
                            value={field.value ?? ""}
                          />
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
                    <Button type="submit" disabled={submitPhase !== "idle"}>
                      {submitPhase === "testing"
                        ? "Testing connection..."
                        : submitPhase === "creating"
                          ? "Creating..."
                          : "Test & Create"}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
