"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { MoreHorizontal, Plus, Plug } from "lucide-react";
import { toast } from "sonner";
import { AddIntegrationDialog } from "./add-integration-dialog";
import type { IntegrationConnection } from "@/lib/integrations/types";

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

      {connections.map((conn) => (
        <Card key={conn.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle className="text-base flex items-center gap-2">
                {conn.name}
                <Badge variant="secondary">{conn.type}</Badge>
              </CardTitle>
              {conn.description && <CardDescription>{conn.description}</CardDescription>}
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
          <CardContent>
            <div className="text-sm text-muted-foreground">
              {conn.credentials?.url} &middot; {conn.credentials?.db}
              {conn.data?.lastSyncAt && (
                <span className="ml-2">
                  &middot; Last synced: {formatRelativeTime(conn.data.lastSyncAt)}
                </span>
              )}
              {!conn.data?.lastSyncAt && <span className="ml-2">&middot; Not synced yet</span>}
            </div>
          </CardContent>
        </Card>
      ))}

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
