"use client";

import { useState } from "react";
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
import { Loader2, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import type { ImapTestInput, ImapCreateInput } from "@/lib/schemas/imap";

interface AutodiscoverResponse {
  config: Partial<{
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    security: "tls" | "starttls" | "none";
  }>;
  source: "provider-table" | "dns-srv" | "guess" | "none";
}

// The create UI only offers the two security modes that matter to a user
// picking server settings by hand — "tls" (works for the vast majority of
// modern providers on port 993/465) and "none". STARTTLS is dropped from
// this form only: the backend now derives tls vs starttls from the port, so
// the distinction no longer changes behavior here. `imapCreateSchema` still
// accepts "starttls" for autodiscover results and the edit form.
type CreateSecurity = "tls" | "none";
type Security = "tls" | "starttls" | "none";

interface FormState {
  senderName: string;
  email: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  username: string;
  password: string;
  security: Security;
}

const INITIAL_STATE: FormState = {
  senderName: "",
  email: "",
  imapHost: "",
  imapPort: "993",
  smtpHost: "",
  smtpPort: "587",
  username: "",
  password: "",
  security: "tls",
};

// Fields that autodiscover prefill is allowed to touch. Once the user has
// edited one of these, prefill leaves it alone — see `touched` below.
type PrefillableField = "imapHost" | "imapPort" | "smtpHost" | "smtpPort" | "security";

type ServerSettingsSource = AutodiscoverResponse["source"];

interface ImapConnectStepProps {
  /** Called after the connection is created — the caller closes the dialog. */
  onSuccess: (connection: { id: string; name: string }) => void;
  onCancel: () => void;
}

export function ImapConnectStep({ onSuccess, onCancel }: ImapConnectStepProps) {
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [touched, setTouched] = useState<Set<PrefillableField>>(new Set());
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Progressive disclosure: server settings default to collapsed once
  // autodiscover confidently finds a provider match, expanded otherwise
  // (guess/none). Once the user expands (via the "Edit server settings"
  // button) or edits a field, `userExpanded` locks it open — a later
  // autodiscover re-run (e.g. re-blurring the email field) must never
  // collapse the grid back out from under the user's cursor.
  const [serverSettingsExpanded, setServerSettingsExpanded] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const [source, setSource] = useState<ServerSettingsSource>("none");

  const [flightStatus, setFlightStatus] = useState<"idle" | "testing" | "saving" | "failure">(
    "idle"
  );
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestError(null);
    setSaveError(null);
    if (flightStatus === "failure") {
      setFlightStatus("idle");
    }

    if (key === "username") {
      setUsernameTouched(true);
    }
    if (
      key === "imapHost" ||
      key === "imapPort" ||
      key === "smtpHost" ||
      key === "smtpPort" ||
      key === "security"
    ) {
      setTouched((prev) => new Set(prev).add(key as PrefillableField));
      // Editing a server-settings field only happens once the grid is
      // visible, but guard anyway so it can never re-collapse.
      setServerSettingsExpanded(true);
      setUserExpanded(true);
    }
  }

  async function handleEmailBlur() {
    const email = form.email.trim();
    if (!email) return;

    // Best-effort — failures here are silent and never block the user.
    try {
      const result = await apiGet<AutodiscoverResponse>(
        `/api/integrations/imap/autodiscover?email=${encodeURIComponent(email)}`
      );
      const config = result?.config ?? {};

      setSource(result?.source ?? "none");
      // Confident matches collapse into a summary; guesses/no-match stay
      // expanded so the user can review or fill in values. Never collapse
      // again once the user has expanded or edited the grid themselves.
      if (!userExpanded) {
        if (result?.source === "provider-table" || result?.source === "dns-srv") {
          setServerSettingsExpanded(false);
        } else {
          setServerSettingsExpanded(true);
        }
      }

      setForm((prev) => {
        const next = { ...prev };
        if (!touched.has("imapHost") && config.imapHost) {
          next.imapHost = config.imapHost;
        }
        if (!touched.has("imapPort") && config.imapPort) {
          next.imapPort = String(config.imapPort);
        }
        if (!touched.has("smtpHost") && config.smtpHost) {
          next.smtpHost = config.smtpHost;
        }
        if (!touched.has("smtpPort") && config.smtpPort) {
          next.smtpPort = String(config.smtpPort);
        }
        if (!touched.has("security") && config.security) {
          next.security = config.security;
        }
        if (!usernameTouched && !prev.username) {
          next.username = email;
        }
        return next;
      });
    } catch {
      // Autodiscovery is best-effort — never surface an error to the user.
    }
  }

  // Username defaults to the email address and stays in sync with it until
  // the user edits the username directly — same touched-tracking pattern as
  // the autodiscovered host/port fields.
  function handleEmailChange(value: string) {
    setForm((prev) => {
      const next = { ...prev, email: value };
      if (!usernameTouched) {
        next.username = value;
      }
      return next;
    });
    setTestError(null);
    setSaveError(null);
    if (flightStatus === "failure") {
      setFlightStatus("idle");
    }
  }

  function buildTestBody(): ImapTestInput {
    return {
      imapHost: form.imapHost,
      imapPort: Number(form.imapPort),
      smtpHost: form.smtpHost,
      smtpPort: Number(form.smtpPort),
      username: form.username,
      password: form.password,
      security: form.security,
    };
  }

  async function handleTestAndSave() {
    setTestError(null);
    setSaveError(null);
    setFlightStatus("testing");

    try {
      const result = await apiPost<{ ok: boolean; error?: string }>(
        "/api/integrations/imap/test",
        buildTestBody()
      );

      if (!result.ok) {
        setFlightStatus("failure");
        setTestError(result.error ?? "Connection test failed");
        setServerSettingsExpanded(true);
        setUserExpanded(true);
        return;
      }
    } catch (err) {
      setFlightStatus("failure");
      setTestError(err instanceof ApiError ? err.message : "Connection test failed");
      setServerSettingsExpanded(true);
      setUserExpanded(true);
      return;
    }

    setFlightStatus("saving");

    const body: ImapCreateInput = {
      ...buildTestBody(),
      ...(form.senderName.trim() ? { senderName: form.senderName.trim() } : {}),
    };

    try {
      const connection = await apiPost<{ id: string; name: string }>(
        "/api/integrations/imap",
        body
      );
      toast.success("Email connection ready");
      setFlightStatus("idle");
      onSuccess(connection);
    } catch (err) {
      setFlightStatus("failure");
      setSaveError(err instanceof ApiError ? err.message : "Failed to create the connection");
    }
  }

  const inFlight = flightStatus === "testing" || flightStatus === "saving";
  const canSubmit = !inFlight && form.email.trim().length > 0 && form.password.trim().length > 0;

  const summary =
    !serverSettingsExpanded && (source === "provider-table" || source === "dns-srv")
      ? `Server settings found — IMAP ${form.imapHost}:${form.imapPort} · SMTP ${form.smtpHost}:${form.smtpPort}`
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="imap-sender-name">Your name</Label>
        <Input
          id="imap-sender-name"
          placeholder="Clemens Helm"
          value={form.senderName}
          onChange={(e) => updateField("senderName", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Shown to recipients when this mailbox sends email. Optional.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="imap-email">Email address</Label>
        <Input
          id="imap-email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={(e) => handleEmailChange(e.target.value)}
          onBlur={handleEmailBlur}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="imap-password">Password</Label>
        <div className="relative">
          <Input
            id="imap-password"
            type={showPassword ? "text" : "password"}
            className="pr-10"
            placeholder="App password or account password"
            value={form.password}
            onChange={(e) => updateField("password", e.target.value)}
          />
          <button
            type="button"
            className="absolute right-0 top-0 h-full px-3 py-2 text-muted-foreground hover:text-foreground"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">App password or account password</p>
      </div>

      {summary ? (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3">
          <p className="text-sm">{summary}</p>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm"
            onClick={() => {
              setServerSettingsExpanded(true);
              setUserExpanded(true);
            }}
          >
            Edit server settings
          </Button>
        </div>
      ) : (
        <div className="space-y-4 rounded-md border p-3">
          {source === "guess" && (
            <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                We couldn&apos;t find your provider&apos;s settings, so these are a best guess —
                please verify with your provider.
              </span>
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-2">
              <Label htmlFor="imap-host">IMAP host</Label>
              <Input
                id="imap-host"
                placeholder="imap.example.com"
                value={form.imapHost}
                onChange={(e) => updateField("imapHost", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="imap-port">IMAP port</Label>
              <Input
                id="imap-port"
                className="w-20"
                inputMode="numeric"
                value={form.imapPort}
                onChange={(e) => updateField("imapPort", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-2">
              <Label htmlFor="smtp-host">SMTP host</Label>
              <Input
                id="smtp-host"
                placeholder="smtp.example.com"
                value={form.smtpHost}
                onChange={(e) => updateField("smtpHost", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-port">SMTP port</Label>
              <Input
                id="smtp-port"
                className="w-20"
                inputMode="numeric"
                value={form.smtpPort}
                onChange={(e) => updateField("smtpPort", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="imap-username">Username</Label>
            <Input
              id="imap-username"
              placeholder="you@example.com"
              value={form.username}
              onChange={(e) => updateField("username", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="imap-security">Security</Label>
            <Select
              value={form.security === "starttls" ? "tls" : form.security}
              onValueChange={(value) => updateField("security", value as CreateSecurity)}
            >
              <SelectTrigger id="imap-security" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tls">Automatic (TLS)</SelectItem>
                <SelectItem value="none">None (insecure)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {testError && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{testError}</span>
            </div>
          )}
        </div>
      )}

      {saveError && (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={handleTestAndSave}>
          {flightStatus === "testing" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Testing…
            </>
          ) : flightStatus === "saving" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Test & Save"
          )}
        </Button>
      </div>
    </div>
  );
}
