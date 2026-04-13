"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

interface GoogleOAuthState {
  configured: boolean;
  clientId: string;
}

export function SettingsOAuth() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/oauth?provider=google");
      if (res.ok) {
        const data: GoogleOAuthState = await res.json();
        setConfigured(data.configured);
        setClientId(data.clientId || "");
      }
    } catch {
      // ignore fetch errors on mount
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  async function handleSave() {
    setSaving(true);
    setError("");

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

      if (!res.ok) {
        let message = "Failed to save OAuth settings";
        try {
          const data = await res.json();
          if (data.error) message = data.error;
        } catch {
          // response body was not JSON
        }
        setError(message);
        return;
      }

      setClientSecret("");
      toast.success("Google OAuth settings saved");
      await fetchSettings();
    } catch {
      setError("Failed to save OAuth settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>OAuth Providers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Google</h3>
            {configured && (
              <CheckCircle2
                className="size-4 text-green-600"
                data-testid="oauth-configured-indicator"
              />
            )}
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="google-client-id">Client ID</Label>
              <Input
                id="google-client-id"
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="123456789.apps.googleusercontent.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="google-client-secret">Client Secret</Label>
              <Input
                id="google-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  configured ? "Already configured — enter new value to update" : "GOCSPX-..."
                }
              />
            </div>

            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              Credentials are encrypted at rest and never leave your server.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
