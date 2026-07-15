"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/api-key-scopes";
import type { CreateApiKeyInput } from "@/lib/schemas/api-keys";

// Friendly labels for the (small, closed) set of API_KEY_SCOPES. A Map (not a
// plain object) so the lookup — keyed off a value that's always a validated
// ApiKeyScope, never arbitrary input — stays outside eslint-plugin-security's
// detect-object-injection sink, matching the OAUTH_ERROR_MESSAGES convention
// in settings-integrations.tsx.
const SCOPE_LABELS = new Map<ApiKeyScope, string>([
  ["agents:read", "Read agents"],
  ["agents:write", "Create agents"],
  ["agents:delete", "Delete agents"],
]);

function scopeLabel(scope: ApiKeyScope): string {
  return SCOPE_LABELS.get(scope) ?? scope;
}

/** GET /api/settings/api-keys row shape (#572, Task 5.2) — masked, org-wide. */
interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
  enabled: boolean;
}

/** POST /api/settings/api-keys 201 response — carries the ONE-TIME plaintext key. */
interface CreatedApiKey {
  id: string;
  key: string;
  name: string;
  scopes: ApiKeyScope[];
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString();
}

export function SettingsApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  // The ONE-TIME plaintext secret lives ONLY here, only while its dedicated
  // modal is open. Never written into `keys` (the list only ever holds the
  // masked `start`), never persisted, never re-fetched — cleared the moment
  // the modal closes (see the Dialog's onOpenChange below).
  const [newKey, setNewKey] = useState<CreatedApiKey | null>(null);
  const { isCopied, copy } = useCopyToClipboard();

  // Form state
  const [formName, setFormName] = useState("");
  const [formScopes, setFormScopes] = useState<ApiKeyScope[]>([]);
  const [formExpiresInDays, setFormExpiresInDays] = useState("");
  // Field-scoped server validation errors (Zod flatten() under
  // details.fieldErrors), same convention as settings-groups.tsx.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const fetchKeys = useCallback(async () => {
    try {
      const data = await apiGet<{ keys: ApiKeyRow[] }>("/api/settings/api-keys");
      setKeys(data.keys);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred past the effect body so the eventual setKeys/setLoading calls
    // happen in a microtask, not synchronously inside the effect
    // (react-hooks/set-state-in-effect) — same pattern as settings-groups.tsx
    // / settings-integrations.tsx's fetchAppConfigured.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void fetchKeys();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchKeys]);

  /**
   * Pulls Zod's flattened fieldErrors out of an ApiError (if present) and
   * returns a flat `{ fieldName: message }` map. Returns null when the error
   * is not a structured field-level validation failure — caller should fall
   * back to a toast in that case. (Same helper as settings-groups.tsx.)
   */
  function extractFieldErrors(e: unknown): Record<string, string> | null {
    if (!(e instanceof ApiError) || !e.details) return null;
    const details = e.details as { fieldErrors?: Record<string, string[]> };
    const fe = details.fieldErrors;
    if (!fe || typeof fe !== "object") return null;
    const flat: Record<string, string> = {};
    for (const [field, messages] of Object.entries(fe)) {
      if (Array.isArray(messages) && messages.length > 0) flat[field] = messages[0];
    }
    return Object.keys(flat).length > 0 ? flat : null;
  }

  function openCreateDialog() {
    setFormName("");
    setFormScopes([]);
    setFormExpiresInDays("");
    setFieldErrors({});
    setCreateOpen(true);
  }

  function toggleScope(scope: ApiKeyScope) {
    setFormScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  async function handleCreate() {
    setFieldErrors({});
    // Default-deny mirrors the server schema's min(1) — the issuer must make
    // an explicit scope choice. Belt-and-suspenders: the Create button below
    // is already disabled in this state.
    if (formScopes.length === 0) {
      setFieldErrors({ scopes: "Select at least one scope." });
      return;
    }

    const body: CreateApiKeyInput = { name: formName, scopes: formScopes };
    const trimmedExpiry = formExpiresInDays.trim();
    if (trimmedExpiry) {
      body.expiresInDays = Number(trimmedExpiry);
    }

    let created: CreatedApiKey;
    try {
      created = await apiPost<CreatedApiKey, CreateApiKeyInput>("/api/settings/api-keys", body);
    } catch (e) {
      const fe = extractFieldErrors(e);
      if (fe) {
        setFieldErrors(fe);
        return;
      }
      toast.error(e instanceof ApiError ? e.message : "Failed to create API key");
      return;
    }

    // Close the create form and hand the plaintext secret to its OWN modal —
    // never render it inside the list, and refetch so the list shows the new
    // key masked (start only).
    setCreateOpen(false);
    setNewKey(created);
    fetchKeys();
  }

  async function handleRevoke(id: string) {
    try {
      await apiDelete(`/api/settings/api-keys/${id}`);
      setRevokeTarget(null);
      fetchKeys();
      toast.success("API key revoked.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to revoke API key");
    }
  }

  async function handleCopy() {
    if (newKey) await copy(newKey.key);
  }

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>API Keys</CardTitle>
          <Button onClick={openCreateDialog}>New API Key</Button>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API keys yet. Create one to let external tools provision agents through the API.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name || "—"}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {key.start ? `${key.start}…` : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary" className="text-xs">
                            {scopeLabel(scope)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(key.createdAt)}</TableCell>
                    <TableCell>{formatDate(key.expiresAt)}</TableCell>
                    <TableCell>{formatDate(key.lastRequest)}</TableCell>
                    <TableCell>
                      <Button variant="destructive" size="sm" onClick={() => setRevokeTarget(key)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API Key</DialogTitle>
            <DialogDescription>
              Create a key so external tools can provision agents through the API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apikey-name">Name</Label>
              <Input
                id="apikey-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. CI provisioning"
                maxLength={32}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? "apikey-name-error" : undefined}
              />
              {fieldErrors.name && (
                <p id="apikey-name-error" className="text-sm text-destructive">
                  {fieldErrors.name}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="space-y-2">
                {API_KEY_SCOPES.map((scope) => (
                  <div key={scope} className="flex items-center space-x-2">
                    <Checkbox
                      id={`scope-${scope}`}
                      checked={formScopes.includes(scope)}
                      onCheckedChange={() => toggleScope(scope)}
                    />
                    <Label htmlFor={`scope-${scope}`} className="cursor-pointer text-sm">
                      {scopeLabel(scope)}
                    </Label>
                  </div>
                ))}
              </div>
              {fieldErrors.scopes && (
                <p className="text-sm text-destructive">{fieldErrors.scopes}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="apikey-expires">Expires in (days)</Label>
              <Input
                id="apikey-expires"
                type="number"
                min={1}
                max={365}
                step={1}
                value={formExpiresInDays}
                onChange={(e) => setFormExpiresInDays(e.target.value)}
                placeholder="Never"
                aria-invalid={fieldErrors.expiresInDays ? true : undefined}
                aria-describedby={fieldErrors.expiresInDays ? "apikey-expires-error" : undefined}
              />
              {fieldErrors.expiresInDays && (
                <p id="apikey-expires-error" className="text-sm text-destructive">
                  {fieldErrors.expiresInDays}
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!formName.trim() || formScopes.length === 0}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ONE-TIME plaintext display — a dedicated modal, separate from the
          create dialog above. The secret is shown exactly once here; closing
          this modal (via Done, the X button, Escape, or an outside click all
          route through onOpenChange) always clears `newKey`. */}
      <Dialog
        open={!!newKey}
        onOpenChange={(open) => {
          if (!open) setNewKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              This is the only time you&apos;ll see this key. Copy it now — you won&apos;t be able
              to see it again.
            </DialogDescription>
          </DialogHeader>
          {newKey && (
            <div className="space-y-4">
              <p className="break-all rounded bg-muted p-2 font-mono text-sm">{newKey.key}</p>
              <Button onClick={handleCopy}>{isCopied ? "Copied!" : "Copy"}</Button>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setNewKey(null)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation — irreversible (hard delete), so it gets a
          confirm step like Delete Group. */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke &ldquo;{revokeTarget?.name || "this key"}&rdquo;? Any client using it will
              immediately lose access. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => revokeTarget && handleRevoke(revokeTarget.id)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
