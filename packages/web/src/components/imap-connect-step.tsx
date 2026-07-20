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
import type { ImapTestInput, ImapCreateInput, ImapTestResult } from "@/lib/schemas/imap";

interface AutodiscoverResponse {
  config: Partial<{
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    security: "tls" | "starttls" | "none";
  }>;
  source: "provider-table" | "dns-srv" | "mx-provider" | "guess" | "none";
}

// Sources confident enough to collapse the server-settings grid into a
// summary instead of showing the raw fields (and the "best guess" caution
// line). Both call sites below check against this ONE set so they can never
// drift apart on which sources count as "confident".
const CONFIDENT_SOURCES = new Set<AutodiscoverResponse["source"]>([
  "provider-table",
  "dns-srv",
  "mx-provider",
]);

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
  /**
   * Optional: return to the integration-type picker. When provided a "Back"
   * button appears, matching the Odoo/web-search connect steps so a user who
   * picked IMAP by mistake doesn't have to close the whole dialog.
   */
  onBack?: () => void;
}

export function ImapConnectStep({ onSuccess, onCancel, onBack }: ImapConnectStepProps) {
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
  // The full structured diagnostic from the last "Test & Save" attempt (only
  // populated when the server actually returned one — an ApiError from a
  // network/5xx failure has no per-leg breakdown, so testResult stays null).
  const [testResult, setTestResult] = useState<ImapTestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestError(null);
    setTestResult(null);
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

    // Best-effort — a failed discovery is silent and never blocks the user.
    let result: AutodiscoverResponse | undefined;
    try {
      result = await apiGet<AutodiscoverResponse>(
        `/api/integrations/imap/autodiscover?email=${encodeURIComponent(email)}`
      );
    } catch {
      // Discovery itself failed (network, 5xx). The user now needs the
      // fields, so open the empty grid instead of leaving them hidden.
      if (!userExpanded) setServerSettingsExpanded(true);
      return;
    }
    const config = result?.config ?? {};

    setSource(result?.source ?? "none");
    // Confident matches collapse into a summary; guesses/no-match expand the
    // grid so the user can review or fill in values. Never collapse again
    // once the user has expanded or edited the grid themselves.
    if (!userExpanded) {
      if (result?.source && CONFIDENT_SOURCES.has(result.source)) {
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
    setTestResult(null);
    setSaveError(null);
    if (flightStatus === "failure") {
      setFlightStatus("idle");
    }
  }

  // `overrides` lets the "Switch to {port} & retry" banner re-run the test
  // with the suggested SMTP port/security immediately, without waiting on a
  // setForm() state update to land first (React state updates are not
  // synchronous, so reading form.smtpPort right after setForm would still see
  // the stale value). smtpPort is a number here (matching ImapTestInput),
  // unlike FormState.smtpPort which holds the raw string input value.
  type TestOverrides = { smtpPort?: number; security?: Security };

  function buildTestBody(overrides?: TestOverrides): ImapTestInput {
    return {
      imapHost: form.imapHost,
      imapPort: Number(form.imapPort),
      smtpHost: form.smtpHost,
      smtpPort: overrides?.smtpPort ?? Number(form.smtpPort),
      username: form.username,
      password: form.password,
      security: overrides?.security ?? form.security,
    };
  }

  async function handleTestAndSave(overrides?: TestOverrides) {
    setTestError(null);
    setTestResult(null);
    setSaveError(null);
    setFlightStatus("testing");

    const testBody = buildTestBody(overrides);
    let result: ImapTestResult;

    try {
      result = await apiPost<ImapTestResult>("/api/integrations/imap/test", testBody);
    } catch (err) {
      setFlightStatus("failure");
      setTestError(err instanceof ApiError ? err.message : "Connection test failed");
      setServerSettingsExpanded(true);
      setUserExpanded(true);
      return;
    }

    setTestResult(result);

    if (!result.ok) {
      setFlightStatus("failure");
      setTestError(result.error ?? "Connection test failed");
      setServerSettingsExpanded(true);
      setUserExpanded(true);
      return;
    }

    setFlightStatus("saving");

    const body: ImapCreateInput = {
      ...testBody,
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

  // The user clicks to apply a suggested port switch — we never auto-switch
  // silently. Updates the visible form fields AND immediately re-runs the
  // test with the same values (passed explicitly, see buildTestBody above).
  function handleSwitchPortAndRetry(port: number, security: "starttls" | "tls") {
    setForm((prev) => ({ ...prev, smtpPort: String(port), security }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add("smtpPort");
      next.add("security");
      return next;
    });
    void handleTestAndSave({ smtpPort: port, security });
  }

  const inFlight = flightStatus === "testing" || flightStatus === "saving";
  const canSubmit = !inFlight && form.email.trim().length > 0 && form.password.trim().length > 0;

  const summary =
    !serverSettingsExpanded && CONFIDENT_SOURCES.has(source)
      ? `Server settings found — IMAP ${form.imapHost}:${form.imapPort} · SMTP ${form.smtpHost}:${form.smtpPort}`
      : null;

  // Per-leg status line ("IMAP ✓ · SMTP ✗ (couldn't reach smtp.host:465)").
  // Only renders for the new structured contract — a caught ApiError (no
  // per-leg breakdown) or an older mocked `{ ok, error }` shape leaves
  // testResult.imap/testResult.smtp undefined, so this stays hidden rather
  // than throwing.
  //
  // The "couldn't reach" suffix is only truthful for connection-level failures
  // (timeout/refused). An auth or TLS failure means the host WAS reached, so
  // claiming it was unreachable there would be misleading.
  const smtpUnreachable =
    testResult &&
    !testResult.ok &&
    testResult.smtp &&
    !testResult.smtp.ok &&
    (testResult.smtp.code === "timeout" || testResult.smtp.code === "refused");
  const legStatus =
    testResult && !testResult.ok && testResult.imap && testResult.smtp
      ? `IMAP ${testResult.imap.ok ? "✓" : "✗"} · SMTP ${testResult.smtp.ok ? "✓" : "✗"}${
          smtpUnreachable ? ` (couldn't reach ${form.smtpHost}:${form.smtpPort})` : ""
        }`
      : null;

  const suggestion = testResult && !testResult.ok ? testResult.suggestion : undefined;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="imap-sender-name">Your name</Label>
        <Input
          id="imap-sender-name"
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
      </div>

      {!summary && !serverSettingsExpanded ? (
        // Initial state: no server fields at all. They appear only after
        // autodiscover has run (summary or expanded grid) — or on explicit
        // request, for users who already know their settings.
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-sm"
          onClick={() => {
            setServerSettingsExpanded(true);
            setUserExpanded(true);
          }}
        >
          Enter server settings manually
        </Button>
      ) : summary ? (
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

          {legStatus && <p className="text-xs text-muted-foreground">{legStatus}</p>}

          {testError && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{testError}</span>
            </div>
          )}

          {suggestion?.kind === "switch_smtp_port" && (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <p>
                Port {form.smtpPort} is commonly blocked by cloud hosts like Hetzner and
                DigitalOcean — but we can reach port {suggestion.port} from this server.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => handleSwitchPortAndRetry(suggestion.port, suggestion.security)}
              >
                Switch to {suggestion.port} & retry
              </Button>
            </div>
          )}

          {suggestion?.kind === "all_smtp_blocked" && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <p>
                We can&apos;t reach any outbound SMTP port (465, 587, or 25) from this server. Ask
                your host to unblock outbound SMTP, or send through a relay.{" "}
                <a
                  href="https://docs.heypinchy.com/guides/connect-email-imap#ports-tls-and-cloud-firewalls"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  See the troubleshooting guide.
                </a>
              </p>
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
        <div className="flex gap-2">
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <Button type="button" disabled={!canSubmit} onClick={() => handleTestAndSave()}>
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
