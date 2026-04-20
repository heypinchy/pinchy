import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { OdooAccessLevel } from "@/lib/tool-registry";

const OPERATIONS = ["read", "create", "write", "delete"] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface OdooModel {
  model: string;
  name: string;
  access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
}

export interface Connection {
  id: string;
  name: string;
  type: string;
  data: { models?: OdooModel[] } | null;
}

export type OperationFlags = {
  read: boolean;
  create: boolean;
  write: boolean;
  delete: boolean;
};

const FULL_ACCESS: OperationFlags = { read: true, create: true, write: true, delete: true };

/** Returns the default operation flags for a given access level. */
export function operationsForAccessLevel(level: OdooAccessLevel): OperationFlags {
  switch (level) {
    case "read-only":
      return { read: true, create: false, write: false, delete: false };
    case "read-write":
      return { read: true, create: true, write: true, delete: false };
    case "full":
      return { read: true, create: true, write: true, delete: true };
    case "custom":
      return { read: true, create: false, write: false, delete: false };
  }
}

/** Detect access level from a set of models with their operations. */
export function detectAccessLevelFromModels(models: Map<string, OperationFlags>): OdooAccessLevel {
  if (models.size === 0) return "read-only";

  const presets: [OdooAccessLevel, OperationFlags][] = [
    ["full", operationsForAccessLevel("full")],
    ["read-write", operationsForAccessLevel("read-write")],
    ["read-only", operationsForAccessLevel("read-only")],
  ];

  for (const [level, expected] of presets) {
    let allMatch = true;
    for (const [, ops] of models) {
      if (
        ops.read !== expected.read ||
        ops.create !== expected.create ||
        ops.write !== expected.write ||
        ops.delete !== expected.delete
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return level;
  }

  return "custom";
}

export interface UseOdooPermissionsReturn {
  connections: Connection[];
  connectionId: string;
  accessLevel: OdooAccessLevel;
  addedModels: Map<string, OperationFlags>;
  availableModels: OdooModel[];
  loading: boolean;

  setConnectionId: (id: string) => void;
  setAccessLevel: (level: OdooAccessLevel) => void;
  addModel: (modelId: string) => void;
  addAllModels: () => void;
  removeModel: (modelId: string) => void;
  toggleOperation: (modelId: string, operation: Operation) => void;

  getModelAccess: (modelId: string) => OperationFlags;
  getPermissions: () => Array<{ model: string; operation: string }>;
  isDirty: boolean;
}

export function useOdooPermissions(
  agentId: string,
  connections: Connection[]
): UseOdooPermissionsReturn {
  const [connectionId, setConnectionIdState] = useState("");
  const [accessLevel, setAccessLevelState] = useState<OdooAccessLevel>("read-only");
  const [addedModels, setAddedModels] = useState<Map<string, OperationFlags>>(new Map());
  const [loading, setLoading] = useState(true);

  // Track initial state for dirty detection
  const initialConnectionId = useRef("");
  const initialPermissions = useRef<Set<string>>(new Set());

  // Load existing per-agent permissions
  useEffect(() => {
    async function load() {
      try {
        const permsRes = await fetch(`/api/agents/${agentId}/integrations`);

        if (permsRes.ok) {
          const data = await permsRes.json();
          // Only adopt permissions for the odoo connections we were given.
          // Without this filter, the hook would pick up non-odoo entries
          // (e.g. email) and cause the parent to send duplicate PUTs.
          const odooConnectionIds = new Set(connections.map((c) => c.id));
          const odooEntry = data.find((entry: { connectionId: string }) =>
            odooConnectionIds.has(entry.connectionId)
          );
          if (odooEntry) {
            const connId = odooEntry.connectionId;
            setConnectionIdState(connId);
            initialConnectionId.current = connId;

            // Build models map from existing permissions
            const models = new Map<string, OperationFlags>();
            const permSet = new Set<string>();

            for (const perm of odooEntry.permissions) {
              permSet.add(`${perm.model}:${perm.operation}`);
              if (!models.has(perm.model)) {
                models.set(perm.model, {
                  read: false,
                  create: false,
                  write: false,
                  delete: false,
                });
              }
              const flags = models.get(perm.model)!;
              if (OPERATIONS.includes(perm.operation as Operation)) {
                flags[perm.operation as Operation] = true;
              }
            }

            initialPermissions.current = permSet;
            setAddedModels(models);
            setAccessLevelState(detectAccessLevelFromModels(models));
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId, connections]);

  // Get the selected connection object
  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId]
  );

  // All models for the selected connection
  const connectionModels = useMemo(() => {
    if (!selectedConnection?.data?.models) return [];
    return [...selectedConnection.data.models].sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedConnection]);

  // Available models = connection models minus already-added ones
  const availableModels = useMemo(
    () => connectionModels.filter((m) => !addedModels.has(m.model)),
    [connectionModels, addedModels]
  );

  // --- Helpers ---

  const getModelAccess = useCallback(
    (modelId: string): OperationFlags => {
      const model = connectionModels.find((m) => m.model === modelId);
      if (!model?.access) return { ...FULL_ACCESS };
      return { ...model.access };
    },
    [connectionModels]
  );

  /** Clamp desired operations to what the Odoo user can actually do. */
  function clampToAccess(desired: OperationFlags, access: OperationFlags): OperationFlags {
    return {
      read: desired.read && access.read,
      create: desired.create && access.create,
      write: desired.write && access.write,
      delete: desired.delete && access.delete,
    };
  }

  // --- Actions ---

  const setConnectionId = useCallback((id: string) => {
    setConnectionIdState(id);
    setAddedModels(new Map());
    setAccessLevelState("read-only");
  }, []);

  const setAccessLevel = useCallback(
    (level: OdooAccessLevel) => {
      setAccessLevelState(level);
      // Update all existing models to match the new level, clamped by access
      setAddedModels((prev) => {
        const desired = operationsForAccessLevel(level);
        const next = new Map<string, OperationFlags>();
        for (const [model] of prev) {
          const access = getModelAccess(model);
          next.set(model, clampToAccess(desired, access));
        }
        return next;
      });
    },
    [getModelAccess]
  );

  const addModel = useCallback(
    (modelId: string) => {
      setAddedModels((prev) => {
        if (prev.has(modelId)) return prev;
        const desired = operationsForAccessLevel(accessLevel);
        const access = getModelAccess(modelId);
        const next = new Map(prev);
        next.set(modelId, clampToAccess(desired, access));
        return next;
      });
    },
    [accessLevel, getModelAccess]
  );

  const addAllModels = useCallback(() => {
    setAddedModels((prev) => {
      const next = new Map(prev);
      const desired = operationsForAccessLevel(accessLevel);
      for (const m of connectionModels) {
        if (!next.has(m.model)) {
          const access = getModelAccess(m.model);
          next.set(m.model, clampToAccess(desired, access));
        }
      }
      return next;
    });
  }, [connectionModels, accessLevel, getModelAccess]);

  const removeModel = useCallback((modelId: string) => {
    setAddedModels((prev) => {
      const next = new Map(prev);
      next.delete(modelId);
      return next;
    });
  }, []);

  const toggleOperation = useCallback(
    (modelId: string, operation: Operation) => {
      setAddedModels((prev) => {
        const flags = prev.get(modelId);
        if (!flags) return prev;

        // If trying to toggle ON but access doesn't allow it, no-op
        if (!flags[operation]) {
          const access = getModelAccess(modelId);
          if (!access[operation]) return prev;
        }

        const next = new Map(prev);
        const updated = { ...flags, [operation]: !flags[operation] };
        next.set(modelId, updated);

        // Re-detect access level
        const detected = detectAccessLevelFromModels(next);
        setAccessLevelState(detected);

        return next;
      });
    },
    [getModelAccess]
  );

  // --- Output ---

  const getPermissions = useCallback((): Array<{
    model: string;
    operation: string;
  }> => {
    const perms: Array<{ model: string; operation: string }> = [];
    for (const [model, ops] of addedModels) {
      for (const op of OPERATIONS) {
        if (ops[op]) {
          perms.push({ model, operation: op });
        }
      }
    }
    return perms;
  }, [addedModels]);

  const isDirty = useMemo(() => {
    if (loading) return false;

    // No models added and none initially → not configured, not dirty
    if (addedModels.size === 0 && initialPermissions.current.size === 0) return false;

    if (connectionId !== initialConnectionId.current) return true;

    const currentSet = new Set<string>();
    for (const [model, ops] of addedModels) {
      for (const op of OPERATIONS) {
        if (ops[op]) {
          currentSet.add(`${model}:${op}`);
        }
      }
    }

    if (currentSet.size !== initialPermissions.current.size) return true;
    for (const key of currentSet) {
      if (!initialPermissions.current.has(key)) return true;
    }
    return false;
  }, [loading, connectionId, addedModels]);

  return {
    connections,
    connectionId,
    accessLevel,
    addedModels,
    availableModels,
    loading,

    setConnectionId,
    setAccessLevel,
    addModel,
    addAllModels,
    removeModel,
    toggleOperation,

    getModelAccess,
    getPermissions,
    isDirty,
  };
}
