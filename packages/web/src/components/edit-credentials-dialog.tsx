"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { UrlInput } from "@/components/ui/url-input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Loader2 } from "lucide-react";
import { apiPatch, apiPost, ApiError } from "@/lib/api-client";
import { odooEditSchema, webSearchEditSchema } from "@/lib/schemas/integration-edit";
import type { IntegrationConnection } from "@/lib/integrations/types";
import type { z } from "zod";

interface EditCredentialsDialogProps {
  connection: IntegrationConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type OdooFormValues = z.infer<typeof odooEditSchema>;
type WebSearchFormValues = z.infer<typeof webSearchEditSchema>;

function OdooForm({
  connection,
  onSuccess,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onSuccess: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState(false);

  const maskedCreds =
    connection.credentials && typeof connection.credentials === "object"
      ? (connection.credentials as { url?: string; db?: string; login?: string })
      : {};

  const form = useForm<OdooFormValues>({
    resolver: zodResolver(odooEditSchema),
    defaultValues: {
      url: maskedCreds.url ?? "",
      db: maskedCreds.db ?? "",
      login: maskedCreds.login ?? "",
      apiKey: "",
    },
  });

  async function onSubmit(values: OdooFormValues) {
    setSaving(true);
    setServerError("");
    const credentials: Record<string, string> = {};
    if (values.url) credentials.url = values.url;
    if (values.db) credentials.db = values.db;
    if (values.login) credentials.login = values.login;
    if (values.apiKey) credentials.apiKey = values.apiKey;

    try {
      await apiPatch(`/api/integrations/${connection.id}`, { credentials });
      toast.success("Credentials updated");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError("Something went wrong. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {connection.status === "auth_failed" && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Current credentials failed authentication — please enter new credentials below.
            </AlertDescription>
          </Alert>
        )}

        <FormField
          control={form.control}
          name="url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>URL</FormLabel>
              <FormControl>
                <UrlInput placeholder="Leave empty to keep current" {...field} />
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
                <Input placeholder="Leave empty to keep current" {...field} />
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
                <Input placeholder="Leave empty to keep current" {...field} />
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
                <Input type="password" placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
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
      </form>
    </Form>
  );
}

function WebSearchForm({
  connection,
  onSuccess,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onSuccess: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState(false);

  const form = useForm<WebSearchFormValues>({
    resolver: zodResolver(webSearchEditSchema),
    defaultValues: { apiKey: "" },
  });

  async function onSubmit(values: WebSearchFormValues) {
    setSaving(true);
    setServerError("");
    const credentials: Record<string, string> = {};
    if (values.apiKey) credentials.apiKey = values.apiKey;

    try {
      await apiPatch(`/api/integrations/${connection.id}`, { credentials });
      toast.success("Credentials updated");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError("Something went wrong. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {connection.status === "auth_failed" && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Current credentials failed authentication — please enter new credentials below.
            </AlertDescription>
          </Alert>
        )}

        <FormField
          control={form.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API Key</FormLabel>
              <FormControl>
                <Input type="password" placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
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
      </form>
    </Form>
  );
}

function GoogleReconnect({
  connection,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleReconnect() {
    setLoading(true);
    setError("");
    try {
      const result = await apiPost<{ url: string }>("/api/integrations/oauth/start", {
        reconnectConnectionId: connection.id,
      });
      window.location.assign(result.url);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Google credentials are managed via OAuth. Click below to start a new authorization flow.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={handleReconnect} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Redirecting...
            </>
          ) : (
            "Reconnect via Google"
          )}
        </Button>
      </div>
    </div>
  );
}

function MicrosoftReconnect({
  connection,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleReconnect() {
    setLoading(true);
    setError("");
    try {
      const result = await apiPost<{ url: string }>("/api/integrations/oauth/start", {
        reconnectConnectionId: connection.id,
      });
      window.location.assign(result.url);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Microsoft credentials are managed via OAuth. Click below to start a new authorization flow.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={handleReconnect} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Redirecting...
            </>
          ) : (
            "Reconnect via Microsoft"
          )}
        </Button>
      </div>
    </div>
  );
}

export function EditCredentialsDialog({
  connection,
  open,
  onOpenChange,
  onSuccess,
}: EditCredentialsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Credentials</DialogTitle>
          <DialogDescription>
            Update the credentials for{" "}
            <span className="font-medium">{connection?.name ?? "this integration"}</span>. Leave
            fields empty to keep their current values.
          </DialogDescription>
        </DialogHeader>

        {connection?.type === "google" ? (
          <GoogleReconnect connection={connection} onOpenChange={onOpenChange} />
        ) : connection?.type === "microsoft" ? (
          <MicrosoftReconnect connection={connection} onOpenChange={onOpenChange} />
        ) : connection?.type === "odoo" ? (
          <OdooForm
            key={connection.id}
            connection={connection}
            onSuccess={onSuccess}
            onOpenChange={onOpenChange}
          />
        ) : connection?.type === "web-search" ? (
          <WebSearchForm
            key={connection.id}
            connection={connection}
            onSuccess={onSuccess}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
