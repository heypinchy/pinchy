import { useState, useCallback } from "react";
import { toast } from "sonner";
import { apiPost, apiPatch, apiDelete, errorMessage } from "@/lib/api-client";
import type { UpdateConnectionInput } from "@/lib/schemas/integration-edit";

/**
 * The test and sync routes deliberately answer 200 with `{ success: false }`
 * for a *credential* failure — that is a diagnosis, not a request error — and
 * reserve non-2xx for a genuinely broken request (404 unknown connection, 403).
 * So both branches have to be handled: the body's own verdict, and the thrown
 * ApiError.
 */
type ProbeResult = { success?: boolean; error?: string };

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
      const data = await apiPost<ProbeResult>(`/api/integrations/${id}/test`, undefined);
      if (data.success) {
        toast.success("Connection successful");
      } else {
        toast.error(data.error || "Connection test failed");
      }
    } catch (e) {
      toast.error(errorMessage(e, "Failed to test connection"));
    } finally {
      setTesting(null);
    }
  }, []);

  const syncSchema = useCallback(
    async (id: string) => {
      setSyncing(id);
      try {
        const data = await apiPost<ProbeResult>(`/api/integrations/${id}/sync`, undefined);
        if (data.success) {
          toast.success("Schema synced successfully");
        } else {
          toast.error(data.error || "Schema sync failed");
        }
        onChange();
      } catch (e) {
        toast.error(errorMessage(e, "Failed to sync schema"));
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
        await apiPatch<unknown, UpdateConnectionInput>(`/api/integrations/${id}`, {
          name: name.trim(),
        });
        toast.success("Integration renamed");
        onChange();
      } catch (e) {
        toast.error(errorMessage(e, "Failed to rename integration"));
      }
    },
    [onChange]
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/integrations/${id}`);
        toast.success("Integration deleted");
        onChange();
      } catch (e) {
        toast.error(errorMessage(e, "Failed to delete integration"));
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
