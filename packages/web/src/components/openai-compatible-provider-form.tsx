"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, ApiError } from "@/lib/api-client";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import type { UpsertOpenAiCompatibleProviderInput } from "@/lib/schemas/openai-compatible-provider";

// Add/Edit form for the generic "OpenAI-compatible" provider type (#894). Talks
// to the typed api-client with shared request schemas so the client payload
// can't drift from the server contract. The API key is NEVER rendered — on
// edit the key field is blank with a "leave blank to keep" placeholder.
//
// #894 settings redesign: the list/Add-dialog/delete-dialog chrome that used to
// live here as `OpenAiCompatibleProvidersSection` moved into `ProviderKeyForm`'s
// `manageCustomProviders` mode — the unified AI-Provider grid renders one tile
// per custom provider alongside the built-ins instead of a separate card. This
// form component is reused as-is (add mode: `provider={null}`, edit mode:
// `provider={row}`).

/** A provider row as returned by `GET /api/settings/providers/openai-compatible`. */
export interface ProviderListItem {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  models: OpenClawModelDefinition[];
  keyHint: string;
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
