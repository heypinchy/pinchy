"use client";

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
// toast is now handled by useIntegrationActions hook
import { AddIntegrationDialog } from "./add-integration-dialog";
import { EditOAuthDialog } from "./edit-oauth-dialog";
import { BraveIcon, GoogleIcon, OdooIcon } from "./integration-icons";
import type { IntegrationConnection } from "@/lib/integrations/types";
import { getAccessibleCategoryLabels } from "@/lib/integrations/odoo-sync";

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

export function SettingsIntegrations() {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationConnection | null>(null);
  const [renameTarget, setRenameTarget] = useState<IntegrationConnection | null>(null);
  const [renameName, setRenameName] = useState("");
  const [showOAuthEdit, setShowOAuthEdit] = useState(false);
  const [resumeGoogleSetup, setResumeGoogleSetup] = useState(false);

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

  const { testing, syncing, testConnection, syncSchema, renameConnection, deleteConnection } =
    useIntegrationActions(fetchConnections);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

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
                return (
                  <div key={conn.id} className="rounded-lg border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {conn.type === "google" ? (
                          <GoogleIcon className="h-6 w-6 shrink-0" />
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
                          {conn.type === "google" && conn.status === "pending" ? (
                            <>
                              <DropdownMenuItem onClick={() => setResumeGoogleSetup(true)}>
                                Continue setup
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteTarget(conn)}
                              >
                                Remove
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  setRenameTarget(conn);
                                  setRenameName(conn.name);
                                }}
                              >
                                Rename
                              </DropdownMenuItem>
                              {conn.type === "google" ? (
                                <DropdownMenuItem onClick={() => setShowOAuthEdit(true)}>
                                  Edit OAuth Credentials
                                </DropdownMenuItem>
                              ) : (
                                <>
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
                        {conn.type === "google" && conn.status === "pending" ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            <Clock className="h-3 w-3" />
                            Setup in progress
                          </span>
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
                    {conn.agentUsageCount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Used by {conn.agentUsageCount}{" "}
                        {conn.agentUsageCount === 1 ? "agent" : "agents"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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
            <AlertDialogTitle>Delete Integration</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the &ldquo;{deleteTarget?.name}&rdquo; integration and
              remove all associated agent permissions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditOAuthDialog open={showOAuthEdit} onOpenChange={setShowOAuthEdit} />
    </div>
  );
}
