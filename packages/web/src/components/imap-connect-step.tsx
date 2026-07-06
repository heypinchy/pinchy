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
import { Loader2, CheckCircle2, AlertTriangle, Eye, EyeOff } from "lucide-react";
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

type Security = "tls" | "starttls" | "none";

interface FormState {
  name: string;
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
  name: "",
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

  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "failure">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Any field edit invalidates a previous successful test — the user must
    // re-test before Save is enabled again.
    setTestStatus("idle");
    setTestError(null);

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

  async function handleTestConnection() {
    setTestStatus("testing");
    setTestError(null);

    try {
      const result = await apiPost<{ ok: boolean; error?: string }>(
        "/api/integrations/imap/test",
        buildTestBody()
      );

      if (result.ok) {
        setTestStatus("success");
      } else {
        setTestStatus("failure");
        setTestError(result.error ?? "Connection test failed");
      }
    } catch (err) {
      setTestStatus("failure");
      setTestError(err instanceof ApiError ? err.message : "Connection test failed");
    }
  }

  async function handleSave() {
    setSaveError(null);
    setSaving(true);

    const body: ImapCreateInput = {
      name: form.name,
      ...buildTestBody(),
    };

    try {
      const connection = await apiPost<{ id: string; name: string }>(
        "/api/integrations/imap",
        body
      );
      toast.success("Email connection ready");
      onSuccess(connection);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Failed to create the connection");
    } finally {
      setSaving(false);
    }
  }

  const canSave = testStatus === "success" && form.name.trim().length > 0 && !saving;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="imap-name">Name</Label>
        <Input
          id="imap-name"
          placeholder="Work email (IMAP)"
          value={form.name}
          onChange={(e) => updateField("name", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="imap-email">Email address</Label>
        <Input
          id="imap-email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={(e) => updateField("email", e.target.value)}
          onBlur={handleEmailBlur}
        />
        <p className="text-xs text-muted-foreground">
          We&apos;ll try to fill in the server settings below.
        </p>
      </div>

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
      </div>

      <div className="space-y-2">
        <Label htmlFor="imap-security">Security</Label>
        <Select
          value={form.security}
          onValueChange={(value) => updateField("security", value as Security)}
        >
          <SelectTrigger id="imap-security" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tls">TLS</SelectItem>
            <SelectItem value="starttls">STARTTLS</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {testStatus === "success" && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          <span>Connection successful</span>
        </div>
      )}

      {testStatus === "failure" && testError && (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{testError}</span>
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
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={testStatus === "testing"}
            onClick={handleTestConnection}
          >
            {testStatus === "testing" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Testing...
              </>
            ) : (
              "Test connection"
            )}
          </Button>
          <Button type="button" disabled={!canSave} onClick={handleSave}>
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
    </div>
  );
}
