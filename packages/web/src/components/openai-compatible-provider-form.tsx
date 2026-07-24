"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Lock, Plus, Trash2, Pencil, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import type {
  UpsertOpenAiCompatibleProviderInput,
  DeleteOpenAiCompatibleInput,
} from "@/lib/schemas/openai-compatible-provider";

// Settings UI for the generic "OpenAI-compatible" provider type (#894). Mirrors
// the SettingsGroups pattern: a list + Add/Edit dialog + delete AlertDialog, all
// talking to the typed api-client with shared request schemas so the client
// payload can't drift from the server contract. The API key is NEVER rendered —
// on edit the key field is blank with a "leave blank to keep" placeholder, and
// the list shows only a last-4 hint for identification.

/** A provider row as returned by `GET /api/settings/providers/openai-compatible`. */
interface ProviderListItem {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  models: OpenClawModelDefinition[];
  keyHint: string;
}

/** Extract the host of a URL for compact display; falls back to the raw string. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface FormProps {
  /** The provider being edited, or null when adding a new one. */
  provider: ProviderListItem | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function OpenAiCompatibleProviderForm({ provider, onSaved, onCancel }: FormProps) {
  const isEdit = provider !== null;

  const [displayName, setDisplayName] = useState(provider?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  // Manual model-id fallback — ONLY for an endpoint that doesn't list its models
  // via /v1/models (a bare vLLM, say). Hidden by default: the server discovers
  // models on save, exactly like every other provider (#894 — no activation
  // step). Revealed when a save comes back "no models found at this endpoint".
  const [modelIdsText, setModelIdsText] = useState("");
  const [showManual, setShowManual] = useState(false);

  const [saving, setSaving] = useState(false);

  // Field-tied errors stay inline; completed-action failures go to toast.
  const [keyError, setKeyError] = useState("");
  const [baseUrlError, setBaseUrlError] = useState("");
  const [manualError, setManualError] = useState("");
  const [formError, setFormError] = useState("");

  async function handleSubmit() {
    setKeyError("");
    setBaseUrlError("");
    setManualError("");
    setFormError("");

    // Manual ids are the fallback for an endpoint with no /v1/models; the server
    // discovers models itself otherwise, so they're only sent when the manual
    // field is showing and non-empty.
    const manualModelIds = showManual
      ? modelIdsText
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    setSaving(true);
    try {
      const body: UpsertOpenAiCompatibleProviderInput = {
        ...(isEdit ? { id: provider.id } : {}),
        displayName,
        baseUrl,
        // On edit, an empty key means "keep the current one" — omit it entirely.
        ...(apiKey.trim() ? { apiKey } : {}),
        ...(manualModelIds && manualModelIds.length > 0 ? { manualModelIds } : {}),
      };
      await apiPost<ProviderListItem, UpsertOpenAiCompatibleProviderInput>(
        "/api/settings/providers/openai-compatible",
        body
      );
      toast.success(isEdit ? "Provider updated." : "Provider added.");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.details) {
        // Surface server field errors inline where we can map them.
        const fieldErrors = (e.details as { fieldErrors?: Record<string, string[]> }).fieldErrors;
        if (fieldErrors?.baseUrl?.length) {
          setBaseUrlError(fieldErrors.baseUrl[0]);
          setSaving(false);
          return;
        }
        if (fieldErrors?.apiKey?.length) {
          setKeyError(fieldErrors.apiKey[0]);
          setSaving(false);
          return;
        }
        if (fieldErrors?.manualModelIds?.length) {
          // The endpoint exposed no models — reveal the manual field and explain.
          setShowManual(true);
          setManualError(fieldErrors.manualModelIds[0]);
          setSaving(false);
          return;
        }
        if (fieldErrors && Object.keys(fieldErrors).length > 0) {
          const first = Object.values(fieldErrors)[0];
          if (first?.length) {
            setFormError(first[0]);
            setSaving(false);
            return;
          }
        }
      }
      toast.error(e instanceof ApiError ? e.message : "Could not save the provider.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="oai-display-name">Name</Label>
        <Input
          id="oai-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Together AI"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="oai-base-url">Base URL</Label>
        <Input
          id="oai-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.together.xyz/v1"
          aria-invalid={baseUrlError ? true : undefined}
          aria-describedby={baseUrlError ? "oai-base-url-error" : undefined}
        />
        {baseUrlError ? (
          <p id="oai-base-url-error" className="text-sm text-destructive">
            {baseUrlError}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enter it exactly as your provider documents it, including the /v1 path. We detect the
            available models automatically.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="oai-api-key">API key</Label>
        <Input
          id="oai-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEdit ? "Leave blank to keep current key" : "sk-..."}
          aria-invalid={keyError ? true : undefined}
          aria-describedby={keyError ? "oai-api-key-error" : undefined}
        />
        {keyError ? (
          <p id="oai-api-key-error" className="text-sm text-destructive">
            {keyError}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Lock className="size-3" />
            Your API key is encrypted at rest and never leaves your server.
          </p>
        )}
      </div>

      {showManual && (
        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor="oai-model-ids">Model IDs</Label>
          <p className="text-xs text-muted-foreground">
            This endpoint doesn&apos;t list its models. Enter the model ids you want to use,
            separated by commas.
          </p>
          <Input
            id="oai-model-ids"
            value={modelIdsText}
            onChange={(e) => setModelIdsText(e.target.value)}
            placeholder="e.g. llama-3.1-70b-instruct, mixtral-8x7b"
            aria-invalid={manualError ? true : undefined}
            aria-describedby={manualError ? "oai-model-ids-error" : undefined}
          />
          {manualError && (
            <p id="oai-model-ids-error" className="text-sm text-destructive">
              {manualError}
            </p>
          )}
        </div>
      )}

      {formError && <p className="text-sm text-destructive">{formError}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={saving}>
          {saving ? "Saving..." : isEdit ? "Save changes" : "Add provider"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The AI Provider tab section that lists configured OpenAI-compatible instances
 * and orchestrates Add / Edit / Delete. The form above lives inside a Dialog.
 */
export function OpenAiCompatibleProvidersSection() {
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      const rows = await apiGet<ProviderListItem[]>("/api/settings/providers/openai-compatible");
      setProviders(rows);
    } catch {
      // Non-blocking: the section just shows its empty state on a read failure.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void fetchProviders();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchProviders]);

  function openAdd() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(provider: ProviderListItem) {
    setEditing(provider);
    setDialogOpen(true);
  }

  function handleSaved() {
    setDialogOpen(false);
    setEditing(null);
    void fetchProviders();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const body: DeleteOpenAiCompatibleInput = { id: deleteTarget.id };
      await apiDelete<{ ok: true }, DeleteOpenAiCompatibleInput>(
        "/api/settings/providers/openai-compatible",
        body
      );
      toast.success("Provider removed.");
      setDeleteTarget(null);
      void fetchProviders();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not remove the provider.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>OpenAI-compatible providers</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect any endpoint that speaks the OpenAI API — self-hosted or third-party.
          </p>
        </div>
        <Button type="button" onClick={openAdd}>
          <Plus className="size-4" />
          Add provider
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No OpenAI-compatible providers yet. Add one to get started.
          </p>
        ) : (
          <ul className="divide-y">
            {providers.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                <div className="flex items-center gap-3 min-w-0">
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{p.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {hostOf(p.baseUrl)} · key ····{p.keyHint}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(p)}
                    aria-label={`Edit ${p.displayName}`}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(p)}
                    aria-label={`Remove ${p.displayName}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit provider" : "Add provider"}</DialogTitle>
            <DialogDescription>
              Connect an OpenAI-compatible endpoint. We detect its models automatically.
            </DialogDescription>
          </DialogHeader>
          {/* Remount on target change so the form's initial state resets. */}
          {dialogOpen && (
            <OpenAiCompatibleProviderForm
              key={editing?.id ?? "new"}
              provider={editing}
              onSaved={handleSaved}
              onCancel={() => setDialogOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove provider?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {deleteTarget?.displayName ?? "this provider"}. Any agents using its
              models will be switched to another configured provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
