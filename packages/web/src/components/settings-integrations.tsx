"use client";

import { useState, useEffect, useCallback } from "react";
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
import { MoreHorizontal, Plus, Plug, CheckCircle2, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { AddIntegrationDialog } from "./add-integration-dialog";
import { OdooIcon } from "./integration-icons";
import type { IntegrationConnection } from "@/lib/integrations/types";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-sync";

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

function getAccessibleCategories(data: IntegrationConnection["data"]): string[] {
  if (!data?.models) return [];
  const modelNames = new Set(data.models.map((m: { model: string }) => m.model));
  return MODEL_CATEGORIES.filter((cat) => cat.models.some((m) => modelNames.has(m.model))).map(
    (cat) => cat.label
  );
}

export function SettingsIntegrations() {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationConnection | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

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

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  async function testConnection(id: string) {
    setTesting(id);
    try {
      const res = await fetch(`/api/integrations/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success("Connection successful");
      } else {
        toast.error(data.error || "Connection test failed");
      }
    } catch {
      toast.error("Failed to test connection");
    } finally {
      setTesting(null);
    }
  }

  async function syncSchema(id: string) {
    setSyncing(id);
    try {
      const res = await fetch(`/api/integrations/${id}/sync`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success("Schema synced successfully");
        fetchConnections();
      } else {
        toast.error(data.error || "Schema sync failed");
      }
    } catch {
      toast.error("Failed to sync schema");
    } finally {
      setSyncing(null);
    }
  }

  async function deleteConnection() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/integrations/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Integration deleted");
        fetchConnections();
      } else {
        toast.error("Failed to delete integration");
      }
    } catch {
      toast.error("Failed to delete integration");
    } finally {
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Integrations</h3>
          <p className="text-sm text-muted-foreground">
            Connect external systems to give agents access to business data.
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Integration
        </Button>
      </div>

      {connections.map((conn) => {
        const categories = getAccessibleCategories(conn.data);
        return (
          <Card key={conn.id}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <div className="flex items-center gap-3">
                <OdooIcon className="h-6 w-12 shrink-0" />
                <CardTitle className="text-base">{conn.name}</CardTitle>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => testConnection(conn.id)}
                    disabled={testing === conn.id}
                  >
                    {testing === conn.id ? "Testing..." : "Test Connection"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => syncSchema(conn.id)}
                    disabled={syncing === conn.id}
                  >
                    {syncing === conn.id ? "Syncing..." : "Sync Schema"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setDeleteTarget(conn)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardHeader>
            <CardContent className="pt-0">
              <TooltipProvider>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {testing === conn.id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Testing connection...</span>
                    </>
                  ) : syncing === conn.id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Syncing schema...</span>
                    </>
                  ) : conn.data?.lastSyncAt ? (
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
                            Synced {formatRelativeTime(conn.data.lastSyncAt)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{new Date(conn.data.lastSyncAt).toLocaleString()}</p>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <span>Not synced yet</span>
                  )}
                </div>
              </TooltipProvider>
            </CardContent>
          </Card>
        );
      })}

      {connections.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Plug className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">No integrations configured yet.</p>
            <Button variant="outline" className="mt-4" onClick={() => setShowAddDialog(true)}>
              Add your first integration
            </Button>
          </CardContent>
        </Card>
      )}

      <AddIntegrationDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSuccess={() => {
          fetchConnections();
          setShowAddDialog(false);
        }}
      />

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
            <AlertDialogAction variant="destructive" onClick={deleteConnection}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
