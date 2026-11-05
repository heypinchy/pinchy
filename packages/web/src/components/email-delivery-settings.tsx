"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  errorMessage,
  extractFieldErrors,
} from "@/lib/api-client";
import {
  DEFAULT_SMTP_PORT,
  SYSTEM_MAIL_SECURITY,
  securityForPort,
  type SystemMailConfigInput,
  type SystemMailSecurity,
  type SystemMailStatus,
  type SystemMailTestInput,
} from "@/lib/schemas/system-mail";

type PublicConfig = Extract<SystemMailStatus, { configured: true }>["config"];

const SECURITY_LABELS: Record<SystemMailSecurity, string> = {
  starttls: "STARTTLS",
  tls: "TLS",
  none: "None",
};

type FormState = {
  host: string;
  port: string;
  security: SystemMailSecurity;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
};

function formFrom(config: PublicConfig | null): FormState {
  return {
    host: config?.host ?? "",
    port: String(config?.port ?? DEFAULT_SMTP_PORT),
    security: config?.security ?? securityForPort(DEFAULT_SMTP_PORT),
    username: config?.username ?? "",
    password: "",
    fromAddress: config?.fromAddress ?? "",
    fromName: config?.fromName ?? "",
  };
}

/**
 * Settings → Organization → Email delivery (#1309). Off by default: Pinchy
 * sends no email and invite and reset links are shown for the admin to copy.
 *
 * The form asks for what it cannot derive — server, sender, credentials — and
 * derives port and encryption (587 + STARTTLS), shown as one line with
 * "Change". The username follows the sender address until the admin edits it.
 * Saving verifies the connection first, and a failure stays inline in the form.
 */
export function EmailDeliverySettings() {
  const [status, setStatus] = useState<SystemMailStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(formFrom(null));
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [securityTouched, setSecurityTouched] = useState(false);
  const [showServerDetails, setShowServerDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [turningOff, setTurningOff] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SystemMailStatus>("/api/settings/mail")
      .then(setStatus)
      .catch((e) => toast.error(errorMessage(e, "Couldn't load the email settings")));
  }, []);

  if (!status) return null;

  const config = status.configured ? status.config : null;

  function startEditing() {
    setForm(formFrom(config));
    // An existing username is the admin's choice; don't let the sender
    // address overwrite it.
    setUsernameTouched(Boolean(config));
    // Encryption counts as the admin's choice only when it isn't what the
    // port implies anyway; otherwise picking 465 should still switch to TLS.
    setSecurityTouched(Boolean(config && config.security !== securityForPort(config.port)));
    setShowServerDetails(false);
    setFormError(null);
    setFieldErrors({});
    setTestError(null);
    setEditing(true);
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onFromAddressChange(value: string) {
    setForm((prev) => ({
      ...prev,
      fromAddress: value,
      username: usernameTouched ? prev.username : value,
    }));
  }

  function onPortChange(value: string) {
    setForm((prev) => {
      const port = Number(value);
      const security =
        securityTouched || !Number.isInteger(port) ? prev.security : securityForPort(port);
      return { ...prev, port: value, security };
    });
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    const body: SystemMailConfigInput = {
      host: form.host,
      port: Number(form.port),
      security: form.security,
      ...(form.username ? { username: form.username } : {}),
      ...(form.password ? { password: form.password } : {}),
      fromAddress: form.fromAddress,
      ...(form.fromName ? { fromName: form.fromName } : {}),
    };
    try {
      const next = await apiPut<SystemMailStatus, SystemMailConfigInput>(
        "/api/settings/mail",
        body
      );
      setStatus(next);
      setEditing(false);
      toast.success("Email delivery is on. Invitations and reset links will go out by email.");
    } catch (e) {
      // A field the schema refused goes under that field; a failed
      // connection check (host, login, sender) is a form-level message.
      const fields = extractFieldErrors(e);
      if (fields) {
        setFieldErrors(fields);
        if (fields.port || fields.security || fields.fromName) setShowServerDetails(true);
      } else {
        setFormError(errorMessage(e, "Couldn't save the email settings"));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    try {
      const result = await apiPost<{ sent: true; to: string }, SystemMailTestInput>(
        "/api/settings/mail/test",
        {}
      );
      toast.success(`Test email sent to ${result.to}`);
    } catch (e) {
      setTestError(errorMessage(e, "Couldn't send the test email"));
    } finally {
      setTesting(false);
    }
  }

  async function handleTurnOff() {
    setTurningOff(true);
    try {
      setStatus(await apiDelete<SystemMailStatus>("/api/settings/mail"));
      setTestError(null);
      toast.success("Email delivery is off. Links are shown for you to copy.");
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't turn email delivery off"));
    } finally {
      setTurningOff(false);
    }
  }

  // The stored password only follows the server it was typed for, and only
  // while there is a username to log in with (mergeWithStoredPassword).
  const keepsSavedPassword =
    Boolean(config?.hasPassword) &&
    form.host.trim().toLowerCase() === config?.host.toLowerCase() &&
    form.username.trim() !== "";
  const passwordPlaceholder = keepsSavedPassword
    ? "Leave empty to keep the saved password"
    : config?.hasPassword
      ? "Enter the password for this server"
      : undefined;

  function fieldProps(name: string) {
    const message = fieldErrors[name];
    return {
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `mail-${name}-error` : undefined,
    };
  }

  function fieldError(name: string) {
    const message = fieldErrors[name];
    if (!message) return null;
    return (
      <p id={`mail-${name}-error`} className="text-sm text-destructive">
        {message}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {editing ? (
          <form method="post" onSubmit={handleSave} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mail-host">SMTP server</Label>
              <Input
                id="mail-host"
                placeholder="smtp.example.com"
                value={form.host}
                onChange={(e) => setField("host", e.target.value)}
                autoComplete="off"
                {...fieldProps("host")}
              />
              {fieldError("host")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mail-from">Sender address</Label>
              <Input
                id="mail-from"
                type="email"
                placeholder="pinchy@example.com"
                value={form.fromAddress}
                onChange={(e) => onFromAddressChange(e.target.value)}
                {...fieldProps("fromAddress")}
              />
              {fieldError("fromAddress")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mail-username">Username (optional)</Label>
              <Input
                id="mail-username"
                value={form.username}
                onChange={(e) => {
                  setUsernameTouched(true);
                  setField("username", e.target.value);
                }}
                // Not "username": this is the mail server's login, and a
                // password manager would offer to save it as the Pinchy one.
                autoComplete="off"
                {...fieldProps("username")}
              />
              {fieldError("username")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mail-password">Password (optional)</Label>
              <Input
                id="mail-password"
                type="password"
                value={form.password}
                placeholder={passwordPlaceholder}
                onChange={(e) => setField("password", e.target.value)}
                autoComplete="new-password"
                {...fieldProps("password")}
              />
              {fieldError("password")}
            </div>

            {showServerDetails ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="mail-port">Port</Label>
                  <Input
                    id="mail-port"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => onPortChange(e.target.value)}
                    {...fieldProps("port")}
                  />
                  {fieldError("port")}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mail-security">Encryption</Label>
                  <Select
                    value={form.security}
                    onValueChange={(v) => {
                      setSecurityTouched(true);
                      setField("security", v as SystemMailSecurity);
                    }}
                  >
                    <SelectTrigger id="mail-security">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SYSTEM_MAIL_SECURITY.map((s) => (
                        <SelectItem key={s} value={s}>
                          {SECURITY_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mail-from-name">Sender name</Label>
                  <Input
                    id="mail-from-name"
                    placeholder="Pinchy"
                    value={form.fromName}
                    onChange={(e) => setField("fromName", e.target.value)}
                    {...fieldProps("fromName")}
                  />
                  {fieldError("fromName")}
                </div>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>
                  Port {form.port} · {SECURITY_LABELS[form.security]}
                </span>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => setShowServerDetails(true)}
                >
                  Change
                </Button>
              </p>
            )}

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Checking the connection..." : "Save"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : config ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Pinchy emails invitations and password reset links. The link is still shown, so you
              can copy it too.
            </p>
            <p className="text-sm">
              {config.host}:{config.port} · {SECURITY_LABELS[config.security]} · from{" "}
              {config.fromAddress}
            </p>
            {testError && (
              <p role="alert" className="text-sm text-destructive">
                {testError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleTest} disabled={testing}>
                {testing ? "Sending..." : "Send test email"}
              </Button>
              <Button variant="outline" onClick={startEditing}>
                Edit
              </Button>
              <Button variant="outline" onClick={handleTurnOff} disabled={turningOff}>
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Pinchy doesn&apos;t send email. Invite and password reset links are shown for you to
              copy and share. Connect your mail server and Pinchy sends them for you.
            </p>
            <Button onClick={startEditing}>Set up email</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
