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
import { toast } from "sonner";

// --- Integration type registry (extend here for future integrations) ---

interface IntegrationType {
  id: string;
  name: string;
  description: string;
}

const INTEGRATION_TYPES: IntegrationType[] = [
  {
    id: "odoo",
    name: "Odoo",
    description: "Connect your Odoo ERP to query sales, inventory, and customer data.",
  },
  // Future: { id: "shopify", name: "Shopify", description: "..." },
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
    }
    onOpenChange(isOpen);
  }

  function handleBack() {
    setSelectedType(null);
    form.reset();
  }

  async function onSubmit(values: OdooFormValues) {
    try {
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
            // TODO: Replace with real uid from Odoo authenticate() once odoo-node is wired up
            uid: 1,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create integration");
        return;
      }

      toast.success("Integration created successfully");
      form.reset();
      setSelectedType(null);
      onSuccess();
    } catch {
      toast.error("Failed to create integration");
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
              {INTEGRATION_TYPES.map((type) => (
                <button
                  key={type.id}
                  onClick={() => setSelectedType(type.id)}
                  className="flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
                >
                  <span className="font-medium">{type.name}</span>
                  <span className="text-sm text-muted-foreground">{type.description}</span>
                </button>
              ))}
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
                        <Input placeholder="https://odoo.example.com" {...field} />
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
                        <Input placeholder="production" {...field} />
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

                <div className="flex justify-between pt-2">
                  <Button type="button" variant="ghost" onClick={handleBack}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={form.formState.isSubmitting}>
                      {form.formState.isSubmitting ? "Creating..." : "Create"}
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
