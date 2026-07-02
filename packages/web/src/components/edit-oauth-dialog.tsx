"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getOAuthProvider, type OAuthProviderId } from "@/lib/integrations/oauth-providers";

interface EditOAuthDialogProps {
  provider: OAuthProviderId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditOAuthDialog({ provider, open, onOpenChange }: EditOAuthDialogProps) {
  const descriptor = getOAuthProvider(provider);
  const label = descriptor?.label ?? provider;
  const hasTenant = descriptor?.hasTenant ?? false;

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Reset state when the dialog opens — uses React-recommended
  // "adjust state during render" pattern instead of useEffect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setLoading(true);
      setClientSecret("");
      setError("");
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/settings/oauth?provider=${provider}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setClientId(data.clientId || "");
        setTenantId(data.tenantId || "");
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider]);

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const trimmedTenant = tenantId.trim();
      const body =
        hasTenant && trimmedTenant.length > 0
          ? {
              provider,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
              tenantId: trimmedTenant,
            }
          : {
              provider,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
            };
      const res = await fetch("/api/settings/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to save");
        return;
      }
      toast.success(`${label} OAuth settings saved`);
      onOpenChange(false);
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit OAuth Credentials</DialogTitle>
          <DialogDescription>Update your {label} OAuth Client ID and Secret.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-client-id">Client ID</Label>
              <Input
                id="edit-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-client-secret">Client Secret</Label>
              <Input
                id="edit-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Enter new secret to update"
              />
            </div>
            {hasTenant && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-tenant-id">Tenant ID (optional)</Label>
                <Input
                  id="edit-tenant-id"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="Leave blank for common (multi-tenant)"
                />
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Changes apply to all {label} integrations.
            </p>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!canSave || saving}>
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
        )}
      </DialogContent>
    </Dialog>
  );
}
