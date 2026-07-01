"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { CheckCircle2, Loader2 } from "lucide-react";
import { EditOAuthDialog } from "./edit-oauth-dialog";
import { GoogleIcon, MicrosoftIcon } from "./integration-icons";
import {
  OAUTH_PROVIDERS,
  type OAuthProviderId,
  type OAuthProviderDescriptor,
} from "@/lib/integrations/oauth-providers";
import { apiDelete, apiGet, ApiError } from "@/lib/api-client";

interface OAuthAppState {
  configured: boolean;
  clientId: string;
  connectionCount: number;
  tenantId?: string;
}

interface ProviderRowData {
  descriptor: OAuthProviderDescriptor;
  state: OAuthAppState | undefined;
}

// Fixed descriptor list so lookups iterate values instead of indexing a record
// with a dynamic key (avoids object-injection sinks entirely).
const PROVIDER_DESCRIPTORS: OAuthProviderDescriptor[] = [
  OAUTH_PROVIDERS.google,
  OAUTH_PROVIDERS.microsoft,
];

/** Show only the first 6 characters of a Client ID — it's not secret, but a
 * full id is long and noisy, and a short prefix is enough to tell apps apart. */
function maskClientId(clientId: string): string {
  if (clientId.length <= 6) return clientId;
  return `${clientId.slice(0, 6)}…`;
}

function ProviderIcon({ provider }: { provider: OAuthProviderId }) {
  if (provider === "google") return <GoogleIcon className="h-6 w-6 shrink-0" />;
  return <MicrosoftIcon className="h-6 w-6 shrink-0" />;
}

export function ConnectedApps({ onConnectionsChanged }: { onConnectionsChanged?: () => void }) {
  const [rows, setRows] = useState<ProviderRowData[]>(
    PROVIDER_DESCRIPTORS.map((descriptor) => ({ descriptor, state: undefined }))
  );
  const [loaded, setLoaded] = useState(false);
  const [editProvider, setEditProvider] = useState<OAuthProviderId | null>(null);
  const [resetTarget, setResetTarget] = useState<ProviderRowData | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchStates = useCallback(async () => {
    const next = await Promise.all(
      PROVIDER_DESCRIPTORS.map(async (descriptor) => {
        try {
          const state = await apiGet<OAuthAppState>(
            `/api/settings/oauth?provider=${descriptor.id}`
          );
          return { descriptor, state };
        } catch {
          return {
            descriptor,
            state: { configured: false, clientId: "", connectionCount: 0 },
          };
        }
      })
    );
    setRows(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetchStates();
  }, [fetchStates]);

  // Opening the reset confirm refreshes the connection count for that provider so
  // the blast-radius warning reflects mailboxes added/removed since mount (a minor
  // TOCTOU otherwise). If the refetch fails we keep the last-known state as a
  // fallback rather than blocking or crashing the dialog.
  async function openReset(row: ProviderRowData) {
    setResetTarget(row);
    try {
      const fresh = await apiGet<OAuthAppState>(
        `/api/settings/oauth?provider=${row.descriptor.id}`
      );
      setResetTarget((current) =>
        current && current.descriptor.id === row.descriptor.id
          ? { ...current, state: fresh }
          : current
      );
    } catch {
      /* keep the mount-time count as fallback */
    }
  }

  async function handleReset() {
    if (!resetTarget) return;
    const { descriptor } = resetTarget;
    setResetting(true);
    try {
      await apiDelete(`/api/settings/oauth?provider=${descriptor.id}`);
      toast.success(`${descriptor.label} app reset.`);
      setResetTarget(null);
      await fetchStates();
      onConnectionsChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to reset app.");
    } finally {
      setResetting(false);
    }
  }

  const resetLabel = resetTarget?.descriptor.label ?? "";
  const resetCount = resetTarget?.state?.connectionCount ?? 0;

  // Management-only: show a row per already-configured provider app. An app can
  // be configured with zero connected mailboxes (it has an independent
  // lifecycle), so the predicate is `configured`, not the connection count.
  const configuredRows = rows.filter((row) => row.state?.configured === true);

  // Nothing configured yet -> render nothing at all. Apps are set up through the
  // Add Integration wizard; this section only appears once there's an app to
  // manage. Wait for the first load so we don't flash the section out.
  if (!loaded || configuredRows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>
          Manage the Google and Microsoft OAuth apps your team has set up. These credentials are
          shared across every connection for that provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {configuredRows.map((row) => (
          <ProviderRow
            key={row.descriptor.id}
            descriptor={row.descriptor}
            state={row.state}
            onEdit={() => setEditProvider(row.descriptor.id)}
            onReset={() => openReset(row)}
          />
        ))}

        <p className="text-xs text-muted-foreground">
          Rotating just the client secret keeps every mailbox connected. Changing the client ID
          requires reconnecting all mailboxes for that provider.
        </p>
      </CardContent>

      <EditOAuthDialog
        provider={editProvider ?? "google"}
        open={editProvider !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditProvider(null);
            fetchStates();
            onConnectionsChanged?.();
          }
        }}
      />

      <AlertDialog
        open={resetTarget !== null}
        onOpenChange={(open) => !open && !resetting && setResetTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the {resetLabel} app?</AlertDialogTitle>
            <AlertDialogDescription>
              Resetting the {resetLabel} app will disconnect {resetCount} connected mailbox
              {resetCount === 1 ? "" : "es"}. They must be reconnected afterwards. This can&apos;t
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleReset} disabled={resetting}>
              {resetting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                "Reset"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// Rendered only for configured provider apps (the caller filters on
// `state.configured`), so this row always shows the Configured status plus the
// Edit / Reset management actions — there's no not-configured or loading branch.
function ProviderRow({
  descriptor,
  state,
  onEdit,
  onReset,
}: {
  descriptor: OAuthProviderDescriptor;
  state: OAuthAppState | undefined;
  onEdit: () => void;
  onReset: () => void;
}) {
  const clientId = state?.clientId ?? "";
  const connectionCount = state?.connectionCount ?? 0;

  return (
    <div
      data-provider-row={descriptor.id}
      className="flex items-center justify-between gap-3 rounded-lg border p-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon provider={descriptor.id} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{descriptor.label}</div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            <span>Configured</span>
            <span aria-hidden>&middot;</span>
            <code className="rounded bg-muted px-1 py-0.5 font-mono" title="Client ID (shortened)">
              {maskClientId(clientId)}
            </code>
            {connectionCount > 0 && (
              <>
                <span aria-hidden>&middot;</span>
                <span>
                  {connectionCount} mailbox{connectionCount === 1 ? "" : "es"} connected
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive border-destructive/50 hover:bg-destructive/10"
          onClick={onReset}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
