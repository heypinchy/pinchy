import { useState, useCallback } from "react";
import { toast } from "sonner";

/**
 * Hook for integration CRUD actions (test, sync, rename, delete).
 * Extracts testable logic from the SettingsIntegrations component.
 *
 * @param onChange - Called after any successful mutation so the caller can refresh data.
 */
export function useIntegrationActions(onChange: () => void) {
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const testConnection = useCallback(async (id: string) => {
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
  }, []);

  const syncSchema = useCallback(
    async (id: string) => {
      setSyncing(id);
      try {
        const res = await fetch(`/api/integrations/${id}/sync`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          toast.success("Schema synced successfully");
          onChange();
        } else {
          toast.error(data.error || "Schema sync failed");
        }
      } catch {
        toast.error("Failed to sync schema");
      } finally {
        setSyncing(null);
      }
    },
    [onChange]
  );

  const renameConnection = useCallback(
    async (id: string, name: string) => {
      if (!name.trim()) return;
      try {
        const res = await fetch(`/api/integrations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (res.ok) {
          toast.success("Integration renamed");
          onChange();
        } else {
          toast.error("Failed to rename integration");
        }
      } catch {
        toast.error("Failed to rename integration");
      }
    },
    [onChange]
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/integrations/${id}`, { method: "DELETE" });
        if (res.ok) {
          toast.success("Integration deleted");
          onChange();
        } else {
          toast.error("Failed to delete integration");
        }
      } catch {
        toast.error("Failed to delete integration");
      }
    },
    [onChange]
  );

  return {
    testing,
    syncing,
    testConnection,
    syncSchema,
    renameConnection,
    deleteConnection,
  };
}
