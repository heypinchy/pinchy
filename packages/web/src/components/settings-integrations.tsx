"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useIntegrationActions } from "@/hooks/use-integration-actions";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  MoreHorizontal,
  Plus,
  Plug,
  CheckCircle2,
  Loader2,
  Clock,
  AlertTriangle,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AddIntegrationDialog } from "./add-integration-dialog";
import { EditCredentialsDialog } from "./edit-credentials-dialog";
import { ConnectedApps } from "./connected-apps";
import { BraveIcon, GoogleIcon, MicrosoftIcon, OdooIcon } from "./integration-icons";
import type { IntegrationConnection } from "@/lib/integrations/types";
import { getAccessibleCategoryLabels } from "@/lib/integrations/odoo-sync";
import { getOAuthProvider, type OAuthProviderId } from "@/lib/integrations/oauth-providers";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { apiGet } from "@/lib/api-client";

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

// A Map (not a plain object) so the lookup key — which comes from the
// user-controlled ?error= query param — can't reach a prototype property.
// Map.get() is also recognized as a barrier by CodeQL's remote-property-injection
// analysis, keeping the sink clean.
// Provider-agnostic: the OAuth callback emits these same codes for both Google
// and Microsoft flows, so the copy must not name a single provider.
const OAUTH_ERROR_MESSAGES = new Map<string, string>([
  [
    "profile_fetch_failed",
    "Could not fetch your account profile. Check that your OAuth app grants the required profile permission.",
  ],
  [
    "token_exchange_failed",
    "Sign-in worked, but Pinchy couldn't finish connecting — double-check the Client Secret under Connected apps, then try again.",
  ],
  [
    "invalid_token_response",
    "Sign-in worked, but the provider sent back a response Pinchy couldn't read. Please try connecting again.",
  ],
  [
    "missing_refresh_token",
    "Sign-in worked, but the provider didn't return the long-lived token Pinchy needs to keep the mailbox connected. Please try again and be sure to grant offline access.",
  ],
  ["state_mismatch", "OAuth session expired. Please try again."],
  ["not_configured", "OAuth is not configured."],
  ["connection_not_found", "Connection not found. Please try again."],
  ["unauthorized", "OAuth authorization failed. Please try again."],
  ["missing_params", "OAuth authorization failed. Please try again."],
  [
    "consent_declined",
    "You didn't authorize the connection, so nothing changed. You can try again whenever you're ready.",
  ],
  ["provider_error", "The provider reported a problem during sign-in. Please try again."],
]);

export function SettingsIntegrations({ oauthError }: { oauthError?: string } = {}) {
  const router = useRouter();
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationConnection | null>(null);
  const [renameTarget, setRenameTarget] = useState<IntegrationConnection | null>(null);
  const [renameName, setRenameName] = useState("");
  const [resumeGoogleSetup, setResumeGoogleSetup] = useState(false);
  const [editCredConn, setEditCredConn] = useState<IntegrationConnection | null>(null);
  // Derived (never persisted) "is the provider's OAuth app still configured?"
  // flag, keyed by provider id. Starts empty (neither key present) so the
  // active-connection status badge doesn't flash "App not configured" before
  // the fetch resolves — the render only takes that branch once the provider's
  // key is explicitly `false`.
  const [appConfigured, setAppConfigured] = useState<Partial<Record<OAuthProviderId, boolean>>>({});

  // A failed OAuth connect comes back as a ?error= param after a full-page
  // redirect. It's a PERMANENT, actionable config error (e.g. a wrong Client
  // Secret) — so it must persist as an inline banner until dismissed, not a
  // transient toast that vanishes before the user (whose attention is still on
  // the provider's redirect) can read it. See AGENTS.md "Error And Notification
  // UI". Seed local state from the prop ONCE so stripping the URL below doesn't
  // also clear the banner; the dismiss button clears it.
  const [oauthErrorState, setOauthErrorState] = useState<string | undefined>(oauthError);

  useEffect(() => {
    if (!oauthError) return;
    // Strip the ?error= param so a manual refresh doesn't resurrect the banner.
    router.replace("/settings?tab=integrations", { scroll: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally mount-only

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      if (res.ok) {
        setConnections(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Live, per-provider "is this OAuth app currently configured?" state — purely
  // derived from GET /api/settings/oauth?provider=<id>, the same endpoint the
  // Connected apps section already calls. No DB write, no persisted flag: if an
  // admin restores the app, the next fetch flips the badge back automatically.
  // Only fetched for providers that actually have a connection in the list —
  // this both avoids a needless request when e.g. only Odoo is connected, and
  // keeps this component from doubling up mount-time GETs for a provider the
  // Connected apps section already queries.
  // Guards against out-of-order network responses: if the connections list
  // changes again before an in-flight fetchAppConfigured call resolves, a
  // slower older response must not clobber a faster newer one once it lands.
  const appConfiguredRequestId = useRef(0);

  const fetchAppConfigured = useCallback(async (forConnections: IntegrationConnection[]) => {
    const providers = EMAIL_CONNECTION_TYPES.filter((provider) =>
      forConnections.some((conn) => conn.type === provider && conn.status === "active")
    );
    if (providers.length === 0) return;
    const requestId = ++appConfiguredRequestId.current;
    const results = await Promise.all(
      providers.map(async (provider) => {
        try {
          const state = await apiGet<{ configured: boolean }>(
            `/api/settings/oauth?provider=${provider}`
          );
          return [provider, state.configured] as const;
        } catch {
          // Fail closed on network/auth errors: an unknown app state should not
          // be reported as "configured" green.
          return [provider, false] as const;
        }
      })
    );
    if (requestId !== appConfiguredRequestId.current) return; // superseded by a newer call
    setAppConfigured((prev) => ({ ...prev, ...Object.fromEntries(results) }));
  }, []);

  const { testing, syncing, testConnection, syncSchema, renameConnection, deleteConnection } =
    useIntegrationActions(fetchConnections);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    // Deferred past the effect body so the eventual setAppConfigured happens in
    // a microtask, not synchronously inside the effect (react-hooks/
    // set-state-in-effect) — same pattern as connected-apps.tsx / new-agent-form.tsx.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void fetchAppConfigured(connections);
    });
    return () => {
      cancelled = true;
    };
  }, [connections, fetchAppConfigured]);

  // Live-update the list while a connection is still being set up. A pending
  // connection (e.g. an OAuth flow finishing in another tab) flips to
  // active/auth_failed server-side, but the mount-only fetch above would leave
  // the UI stuck on "Setup in progress" until a manual reload. Poll every 10s
  // for as long as at least one connection is pending, then stop.
  const hasPending = connections.some((conn) => conn.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    let cancelled = false;
    const id = setInterval(() => {
      if (!cancelled) void fetchConnections();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasPending, fetchConnections]);

  async function handleRename() {
    if (!renameTarget) return;
    await renameConnection(renameTarget.id, renameName);
    setRenameTarget(null);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await deleteConnection(deleteTarget.id);
    setDeleteTarget(null);
  }

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-6">
      {oauthErrorState && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive/90">
                {OAUTH_ERROR_MESSAGES.get(oauthErrorState) ?? "OAuth connection failed."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss"
              className="shrink-0 text-destructive hover:bg-destructive/10"
              onClick={() => setOauthErrorState(undefined)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Integrations</CardTitle>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Integration
          </Button>
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Plug className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">No integrations configured yet.</p>
              <Button variant="outline" className="mt-4" onClick={() => setShowAddDialog(true)}>
                Add your first integration
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {connections.map((conn) => {
                if (conn.cannotDecrypt) {
                  return (
                    <div
                      key={conn.id}
                      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                          <span className="text-sm font-medium">{conn.name}</span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive border-destructive/50 hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(conn)}
                        >
                          Delete
                        </Button>
                      </div>
                      <p className="text-sm text-destructive/90">
                        This integration can&apos;t be read. It was encrypted with a different{" "}
                        <code className="rounded bg-destructive/10 px-1 py-0.5 text-xs">
                          ENCRYPTION_KEY
                        </code>{" "}
                        than the one this server is using now. Delete it and re-add the connection
                        to restore access.
                      </p>
                    </div>
                  );
                }
                const isOdoo = conn.type === "odoo";
                const categories = isOdoo ? getAccessibleCategoryLabels(conn.data) : [];
                const lastSyncAt =
                  isOdoo && conn.data && typeof conn.data.lastSyncAt === "string"
                    ? conn.data.lastSyncAt
                    : null;
                // Derived, not persisted: a connection whose OAuth app (Google or
                // Microsoft) was reset/deleted still reads "active" from the DB,
                // but any token refresh against it will fail. Only applies to
                // active connections of an OAuth-backed type — pending/auth_failed
                // already have their own, more specific states.
                const oauthProvider = getOAuthProvider(conn.type);
                const appMissing =
                  conn.status === "active" &&
                  oauthProvider !== null &&
                  appConfigured[oauthProvider.id] === false;
                return (
                  <div key={conn.id} className="rounded-lg border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {conn.type === "google" ? (
                          <GoogleIcon className="h-6 w-6 shrink-0" />
                        ) : conn.type === "microsoft" ? (
                          <MicrosoftIcon className="h-6 w-6 shrink-0" />
                        ) : conn.type === "web-search" ? (
                          <BraveIcon className="h-6 w-6 shrink-0" />
                        ) : (
                          <OdooIcon className="h-6 w-12 shrink-0" />
                        )}
                        <span className="text-sm font-medium">{conn.name}</span>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {conn.status === "pending" ? (
                            // A pending connection is a half-finished OAuth setup, not
                            // a live integration. It has no meaningful Rename/Test/etc.
                            // actions — only "Continue setup" (Google resumes via the
                            // AddIntegrationDialog) and "Cancel setup" (aborts the flow
                            // through the same delete path as a real teardown).
                            <>
                              {conn.type === "google" && (
                                <DropdownMenuItem onClick={() => setResumeGoogleSetup(true)}>
                                  Continue setup
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteTarget(conn)}
                              >
                                Cancel setup
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              {(conn.status === "auth_failed" || appMissing) && (
                                <DropdownMenuItem onClick={() => setEditCredConn(conn)}>
                                  Reconnect
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => {
                                  setRenameTarget(conn);
                                  setRenameName(conn.name);
                                }}
                              >
                                Rename
                              </DropdownMenuItem>
                              {conn.type === "google" ? null : conn.type === "microsoft" ? (
                                <DropdownMenuItem
                                  onClick={() => testConnection(conn.id)}
                                  disabled={testing === conn.id}
                                >
                                  {testing === conn.id ? "Testing..." : "Test Connection"}
                                </DropdownMenuItem>
                              ) : (
                                <>
                                  <DropdownMenuItem onClick={() => setEditCredConn(conn)}>
                                    Edit credentials
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => testConnection(conn.id)}
                                    disabled={testing === conn.id}
                                  >
                                    {testing === conn.id ? "Testing..." : "Test Connection"}
                                  </DropdownMenuItem>
                                  {isOdoo && (
                                    <DropdownMenuItem
                                      onClick={() => syncSchema(conn.id)}
                                      disabled={syncing === conn.id}
                                    >
                                      {syncing === conn.id ? "Syncing..." : "Sync Schema"}
                                    </DropdownMenuItem>
                                  )}
                                </>
                              )}
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteTarget(conn)}
                              >
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <TooltipProvider>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        {conn.status === "pending" ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            <Clock className="h-3 w-3" />
                            Setup in progress
                          </span>
                        ) : conn.status === "auth_failed" ? (
                          <>
                            <AlertTriangle
                              className="h-3.5 w-3.5 text-destructive"
                              aria-label="Authentication failed"
                            />
                            <span className="text-sm text-destructive font-medium">
                              Authentication failed
                            </span>
                            {conn.lastError && (
                              <span
                                className="text-xs text-muted-foreground truncate"
                                title={conn.lastError}
                              >
                                {conn.lastError}
                              </span>
                            )}
                          </>
                        ) : appMissing ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-1.5 cursor-default">
                                <AlertTriangle
                                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                                  aria-label="App not configured"
                                />
                                <span className="text-sm text-amber-700 dark:text-amber-400 font-medium">
                                  App not configured
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                The {oauthProvider?.label} app was removed. Restore it under
                                Connected apps, or reconnect this mailbox.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : conn.type === "google" ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                            <span>Connected</span>
                          </>
                        ) : testing === conn.id ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Testing connection...</span>
                          </>
                        ) : syncing === conn.id ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Syncing schema...</span>
                          </>
                        ) : !isOdoo ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                            <span>Connected</span>
                          </>
                        ) : lastSyncAt ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                            <span>Connected</span>
                            <span>&middot;</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default underline decoration-dotted underline-offset-4">
                                  {categories.length} data{" "}
                                  {categories.length === 1 ? "category" : "categories"}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{categories.join(", ")}</p>
                              </TooltipContent>
                            </Tooltip>
                            <span>&middot;</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default underline decoration-dotted underline-offset-4">
                                  Synced {formatRelativeTime(lastSyncAt)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{new Date(lastSyncAt).toLocaleString()}</p>
                              </TooltipContent>
                            </Tooltip>
                          </>
                        ) : (
                          <span>Not synced yet</span>
                        )}
                      </div>
                    </TooltipProvider>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConnectedApps onConnectionsChanged={fetchConnections} />

      <AddIntegrationDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSuccess={() => {
          fetchConnections();
          setShowAddDialog(false);
        }}
        existingTypes={connections.map((c) => c.type)}
      />

      <AddIntegrationDialog
        open={resumeGoogleSetup}
        onOpenChange={setResumeGoogleSetup}
        onSuccess={() => {
          fetchConnections();
          setResumeGoogleSetup(false);
        }}
        initialType="google"
      />

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Integration</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button onClick={handleRename} disabled={!renameName.trim()}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {deleteTarget?.status === "pending" ? (
              <>
                <AlertDialogTitle>Cancel setup</AlertDialogTitle>
                <AlertDialogDescription>
                  This will cancel the setup of &ldquo;{deleteTarget?.name}&rdquo;. The connection
                  was never activated, so nothing that&apos;s in use will be affected. You can start
                  the setup again anytime.
                </AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>Delete Integration</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the &ldquo;{deleteTarget?.name}&rdquo; integration
                  and remove all associated agent permissions. This action cannot be undone.
                </AlertDialogDescription>
              </>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {deleteTarget?.status === "pending" ? "Keep setup" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              {deleteTarget?.status === "pending" ? "Cancel setup" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditCredentialsDialog
        connection={editCredConn}
        open={editCredConn !== null}
        onOpenChange={(o) => !o && setEditCredConn(null)}
        onSuccess={() => {
          setEditCredConn(null);
          fetchConnections();
        }}
      />
    </div>
  );
}
