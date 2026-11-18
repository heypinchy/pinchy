"use client";

import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Eye, EyeOff, Loader2 } from "lucide-react";
import { apiPatch, apiPost, ApiError } from "@/lib/api-client";
import {
  odooEditSchema,
  webSearchEditSchema,
  imapEditSchema,
} from "@/lib/schemas/integration-edit";
import type { IntegrationConnection } from "@/lib/integrations/types";
import {
  canonicalDestinationUrl,
  integrationDestinationChange,
  secretRequiredMessage,
} from "@/lib/secret-destination";
import type { z } from "zod";

interface EditCredentialsDialogProps {
  connection: IntegrationConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type OdooFormValues = z.infer<typeof odooEditSchema>;
type WebSearchFormValues = z.infer<typeof webSearchEditSchema>;

// The IMAP form carries every field as a string (ports included) because the
// inputs are text. We do NOT use imapEditSchema as the react-hook-form resolver:
// its port coercion would fight the string input values. Instead the submit
// handler mirrors OdooForm's "build only the non-empty fields" pattern and runs
// the edited subset through imapEditSchema to coerce ports to numbers and reject
// out-of-range values before the PATCH.
type ImapFormValues = {
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  username: string;
  password: string;
  security: "tls" | "starttls" | "none";
  senderName: string;
};

/**
 * The submit lifecycle every credential form in this dialog shares: clear the
 * previous error, show the spinner, PATCH, toast-and-close on success, surface
 * the server's own message on failure.
 *
 * Written once because it was written three times (#1087). The catch block is
 * the part that matters: a copy that loses the `ApiError` branch degrades a
 * precise server message ("Authentication failed for user X") into the generic
 * fallback, and nothing about the form would look broken.
 */
function useCredentialUpdate(
  connectionId: string,
  onSuccess: () => void,
  onOpenChange: (open: boolean) => void,
  /**
   * Puts a server field error next to its input (e.g. the 422 asking for the
   * API key again after a destination change). Returns false for a field this
   * form does not render, which then falls back to the form-wide message.
   */
  onFieldError?: (field: string, message: string) => boolean
) {
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(credentials: Record<string, unknown>) {
    setSaving(true);
    setServerError("");
    try {
      await apiPatch(`/api/integrations/${connectionId}`, { credentials });
      toast.success("Credentials updated");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const fieldErrors = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)
          ?.fieldErrors;
        const placed = Object.entries(fieldErrors ?? {}).filter(
          ([field, messages]) => messages[0] && onFieldError?.(field, messages[0])
        );
        if (placed.length === 0) setServerError(err.message);
      } else {
        setServerError("Something went wrong. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return { serverError, setServerError, saving, save };
}

/**
 * The "your saved credentials stopped working" banner. Renders nothing unless
 * the connection is actually in `auth_failed`, so each form can place it
 * unconditionally at the top of its fields.
 */
function AuthFailedAlert({ status }: { status: IntegrationConnection["status"] }) {
  if (status !== "auth_failed") return null;
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        Current credentials failed authentication — please enter new credentials below.
      </AlertDescription>
    </Alert>
  );
}

/**
 * The stored secret is bound to where it is sent (lib/secret-destination.ts):
 * once the edit moves the destination, the secret field stops offering "leave
 * empty to keep current". The server enforces the same rule with a 422.
 */
function secretRequirement(
  type: "odoo" | "imap",
  stored: Record<string, unknown>,
  current: Record<string, unknown>
): string | null {
  // An empty field means "keep current", and a URL that does not parse yet is
  // the server's to reject as invalid — neither is a destination change.
  const incoming = Object.fromEntries(
    Object.entries(current).filter(
      ([field, value]) =>
        value !== "" && (field !== "url" || canonicalDestinationUrl(String(value)) !== null)
    )
  );
  return integrationDestinationChange(type, stored, incoming) ? secretRequiredMessage(type) : null;
}

/** Cancel + Save, with Save carrying the in-flight spinner. */
function CredentialFormFooter({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel}>
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
  );
}

function OdooForm({
  connection,
  onSuccess,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onSuccess: () => void;
  onOpenChange: (open: boolean) => void;
}) {
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

  const { serverError, saving, save } = useCredentialUpdate(
    connection.id,
    onSuccess,
    onOpenChange,
    (field, message) => {
      if (field !== "apiKey") return false;
      form.setError("apiKey", { message });
      return true;
    }
  );

  const [url, db] = useWatch({ control: form.control, name: ["url", "db"] });
  const keyRequired = secretRequirement("odoo", maskedCreds, { url, db });

  async function onSubmit(values: OdooFormValues) {
    if (keyRequired && !values.apiKey) {
      form.setError("apiKey", { message: keyRequired });
      return;
    }
    const credentials: Record<string, string> = {};
    if (values.url) credentials.url = values.url;
    if (values.db) credentials.db = values.db;
    if (values.login) credentials.login = values.login;
    if (values.apiKey) credentials.apiKey = values.apiKey;
    await save(credentials);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-4">
        <AuthFailedAlert status={connection.status} />

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
                <Input
                  type="password"
                  placeholder={keyRequired ? "" : "Leave empty to keep current"}
                  aria-required={!!keyRequired}
                  {...field}
                />
              </FormControl>
              <SecretRequiredHint message={keyRequired} hasError={!!form.formState.errors.apiKey} />
              <FormMessage />
            </FormItem>
          )}
        />

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <CredentialFormFooter saving={saving} onCancel={() => onOpenChange(false)} />
      </form>
    </Form>
  );
}

/**
 * Muted explanation under a secret field that must be re-entered; the error
 * replaces it. The input carries `aria-required`, not `required`: native
 * validation would pre-empt submit with a browser bubble, and the inline error
 * this dialog shows for every other field would never render.
 */
function SecretRequiredHint({ message, hasError }: { message: string | null; hasError: boolean }) {
  if (!message || hasError) return null;
  return <p className="text-xs text-muted-foreground">{message}</p>;
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
  const { serverError, saving, save } = useCredentialUpdate(connection.id, onSuccess, onOpenChange);

  const form = useForm<WebSearchFormValues>({
    resolver: zodResolver(webSearchEditSchema),
    defaultValues: { apiKey: "" },
  });

  async function onSubmit(values: WebSearchFormValues) {
    const credentials: Record<string, string> = {};
    if (values.apiKey) credentials.apiKey = values.apiKey;
    await save(credentials);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-4">
        <AuthFailedAlert status={connection.status} />

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

        <CredentialFormFooter saving={saving} onCancel={() => onOpenChange(false)} />
      </form>
    </Form>
  );
}

function ImapForm({
  connection,
  onSuccess,
  onOpenChange,
}: {
  connection: IntegrationConnection;
  onSuccess: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  // Masked credentials (server strips the password). Ports arrive as strings.
  const maskedCreds =
    connection.credentials && typeof connection.credentials === "object"
      ? (connection.credentials as {
          imapHost?: string;
          imapPort?: string;
          smtpHost?: string;
          smtpPort?: string;
          username?: string;
          security?: string;
          senderName?: string;
        })
      : {};

  const maskedSecurity =
    maskedCreds.security === "starttls" || maskedCreds.security === "none"
      ? maskedCreds.security
      : "tls";

  const form = useForm<ImapFormValues>({
    defaultValues: {
      imapHost: maskedCreds.imapHost ?? "",
      imapPort: maskedCreds.imapPort ?? "",
      smtpHost: maskedCreds.smtpHost ?? "",
      smtpPort: maskedCreds.smtpPort ?? "",
      username: maskedCreds.username ?? "",
      password: "",
      security: maskedSecurity,
      senderName: maskedCreds.senderName ?? "",
    },
  });

  const { serverError, setServerError, saving, save } = useCredentialUpdate(
    connection.id,
    onSuccess,
    onOpenChange,
    (field, message) => {
      if (field !== "password") return false;
      form.setError("password", { message });
      return true;
    }
  );

  const [imapHost, imapPort, smtpHost, smtpPort, security] = useWatch({
    control: form.control,
    name: ["imapHost", "imapPort", "smtpHost", "smtpPort", "security"],
  });
  const passwordRequired = secretRequirement("imap", maskedCreds, {
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    security,
  });

  async function onSubmit(values: ImapFormValues) {
    if (passwordRequired && !values.password) {
      form.setError("password", { message: passwordRequired });
      return;
    }
    // Build only the non-empty/edited fields, then coerce ports to numbers and
    // validate the subset with imapEditSchema before sending. senderName
    // follows the same "leave empty to keep current" convention as every
    // other field — see the odoo pattern this mirrors. This means it's not
    // possible to explicitly clear senderName from this form once set; that
    // matches the existing convention for every other field here (e.g.
    // there's no way to clear the username either).
    const edited: Record<string, string> = {};
    if (values.imapHost) edited.imapHost = values.imapHost;
    if (values.imapPort) edited.imapPort = values.imapPort;
    if (values.smtpHost) edited.smtpHost = values.smtpHost;
    if (values.smtpPort) edited.smtpPort = values.smtpPort;
    if (values.username) edited.username = values.username;
    if (values.password) edited.password = values.password;
    if (values.security) edited.security = values.security;
    if (values.senderName && values.senderName !== maskedCreds.senderName) {
      edited.senderName = values.senderName;
    }

    // Client-side validation runs BEFORE the shared save, so a rejected form
    // never shows the spinner at all — the previous inline copy set `saving`
    // first and cleared it again, which is the same end state one frame later.
    const parsed = imapEditSchema.safeParse(edited);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? "Please check your input.");
      return;
    }

    await save(parsed.data);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-4">
        <AuthFailedAlert status={connection.status} />

        <FormField
          control={form.control}
          name="senderName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sender name</FormLabel>
              <FormControl>
                <Input placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="imapHost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>IMAP Host</FormLabel>
              <FormControl>
                <Input placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="imapPort"
          render={({ field }) => (
            <FormItem>
              <FormLabel>IMAP Port</FormLabel>
              <FormControl>
                <Input inputMode="numeric" placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="smtpHost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SMTP Host</FormLabel>
              <FormControl>
                <Input placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="smtpPort"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SMTP Port</FormLabel>
              <FormControl>
                <Input inputMode="numeric" placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input placeholder="Leave empty to keep current" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              {/* The relative wrapper lives OUTSIDE FormControl so FormControl's
                  Radix Slot still forwards the field id/aria onto the Input (its
                  single child) — wrapping the Input in a div would move the id
                  onto the div and break the label association. */}
              <div className="relative">
                <FormControl>
                  <Input
                    type={showPassword ? "text" : "password"}
                    className="pr-10"
                    placeholder={passwordRequired ? "" : "Leave empty to keep current"}
                    aria-required={!!passwordRequired}
                    {...field}
                  />
                </FormControl>
                <button
                  type="button"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <SecretRequiredHint
                message={passwordRequired}
                hasError={!!form.formState.errors.password}
              />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="security"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Security</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="tls">TLS</SelectItem>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <CredentialFormFooter saving={saving} onCancel={() => onOpenChange(false)} />
      </form>
    </Form>
  );
}

// Google and Microsoft both reconnect through the same OAuth start endpoint —
// the server branches on connection.type. The only client-side difference is
// the provider name shown in the copy, so a single parameterized component
// covers both.
function OAuthReconnect({
  connection,
  onOpenChange,
  providerLabel,
}: {
  connection: IntegrationConnection;
  onOpenChange: (open: boolean) => void;
  providerLabel: string;
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
        {providerLabel} credentials are managed via OAuth. Click below to start a new authorization
        flow.
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
            `Reconnect via ${providerLabel}`
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
          <OAuthReconnect
            connection={connection}
            onOpenChange={onOpenChange}
            providerLabel="Google"
          />
        ) : connection?.type === "microsoft" ? (
          <OAuthReconnect
            connection={connection}
            onOpenChange={onOpenChange}
            providerLabel="Microsoft"
          />
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
        ) : connection?.type === "imap" ? (
          <ImapForm
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
