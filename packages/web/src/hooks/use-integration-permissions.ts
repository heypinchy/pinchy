import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// --- Types ---

export type AccessLevel = "read-only" | "read-write" | "full" | "custom";

export interface IntegrationEntity {
  id: string;
  name: string;
  category?: string;
  access?: Record<string, boolean>;
}

export interface IntegrationConnection {
  id: string;
  name: string;
  type: string;
  data: unknown;
}

export interface IntegrationPermissionsConfig {
  type: string;
  operations: readonly string[];
  getEntitiesFromData(data: unknown): IntegrationEntity[];
}

export type OperationFlags = Record<string, boolean>;

// --- Pure helpers ---

/** Returns default operation flags for a given access level and operation set. */
export function operationsForAccessLevel(
  level: AccessLevel,
  operations: readonly string[]
): OperationFlags {
  const flags: OperationFlags = {};
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    switch (level) {
      case "read-only":
        flags[op] = i === 0; // only first operation (read)
        break;
      case "read-write":
        flags[op] = i < operations.length - 1; // all except last (delete)
        break;
      case "full":
        flags[op] = true;
        break;
      case "custom":
        flags[op] = i === 0; // same as read-only default
        break;
    }
  }
  return flags;
}

/** Detect access level from a set of entities with their operations. */
export function detectAccessLevelFromEntities(
  entities: Map<string, OperationFlags>,
  operations: readonly string[]
): AccessLevel {
  if (entities.size === 0) return "read-only";

  const presets: [AccessLevel, OperationFlags][] = [
    ["full", operationsForAccessLevel("full", operations)],
    ["read-write", operationsForAccessLevel("read-write", operations)],
    ["read-only", operationsForAccessLevel("read-only", operations)],
  ];

  for (const [level, expected] of presets) {
    let allMatch = true;
    for (const [, ops] of entities) {
      for (const op of operations) {
        if (ops[op] !== expected[op]) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
    }
    if (allMatch) return level;
  }

  return "custom";
}

// --- Hook return type ---

export interface UseIntegrationPermissionsReturn {
  connections: IntegrationConnection[];
  connectionId: string;
  accessLevel: AccessLevel;
  addedEntities: Map<string, OperationFlags>;
  availableEntities: IntegrationEntity[];
  loading: boolean;

  setConnectionId: (id: string) => void;
  setAccessLevel: (level: AccessLevel) => void;
  addEntity: (entityId: string) => void;
  addAllEntities: () => void;
  removeEntity: (entityId: string) => void;
  toggleOperation: (entityId: string, operation: string) => void;

  getEntityAccess: (entityId: string) => OperationFlags;
  getPermissions: () => Array<{ model: string; operation: string }>;
  isDirty: boolean;
}

// --- Hook ---

export function useIntegrationPermissions(
  config: IntegrationPermissionsConfig,
  agentId: string
): UseIntegrationPermissionsReturn {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [connectionId, setConnectionIdState] = useState("");
  const [accessLevel, setAccessLevelState] = useState<AccessLevel>("read-only");
  const [addedEntities, setAddedEntities] = useState<Map<string, OperationFlags>>(new Map());
  const [loading, setLoading] = useState(true);

  // Track initial state for dirty detection
  const initialConnectionId = useRef("");
  const initialPermissions = useRef<Set<string>>(new Set());

  // Stable ref to config to avoid re-running the effect when config object identity changes
  const configRef = useRef(config);
  configRef.current = config;

  // Build full-access flags for current operations
  const fullAccess = useMemo(() => {
    const flags: OperationFlags = {};
    for (const op of config.operations) {
      flags[op] = true;
    }
    return flags;
  }, [config.operations]);

  // Load connections and existing permissions
  useEffect(() => {
    async function load() {
      const cfg = configRef.current;
      try {
        const [connectionsRes, permsRes] = await Promise.all([
          fetch("/api/integrations"),
          fetch(`/api/agents/${agentId}/integrations`),
        ]);

        if (connectionsRes.ok) {
          const data = await connectionsRes.json();
          // Filter by config type
          const filtered = (data as IntegrationConnection[]).filter((c) => c.type === cfg.type);
          setConnections(filtered);
        }

        if (permsRes.ok) {
          const data = await permsRes.json();
          // Find permissions matching the config type
          const typePerms = (
            data as Array<{
              connectionId: string;
              connectionType: string;
              permissions: Array<{ model: string; operation: string }>;
            }>
          ).find((d) => d.connectionType === cfg.type);

          if (typePerms && typePerms.permissions.length > 0) {
            const connId = typePerms.connectionId;
            setConnectionIdState(connId);
            initialConnectionId.current = connId;

            // Build entities map from existing permissions
            const entities = new Map<string, OperationFlags>();
            const permSet = new Set<string>();

            for (const perm of typePerms.permissions) {
              permSet.add(`${perm.model}:${perm.operation}`);
              if (!entities.has(perm.model)) {
                const flags: OperationFlags = {};
                for (const op of cfg.operations) {
                  flags[op] = false;
                }
                entities.set(perm.model, flags);
              }
              const flags = entities.get(perm.model)!;
              if ((cfg.operations as readonly string[]).includes(perm.operation)) {
                flags[perm.operation] = true;
              }
            }

            initialPermissions.current = permSet;
            setAddedEntities(entities);
            setAccessLevelState(detectAccessLevelFromEntities(entities, cfg.operations));
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId]);

  // Get the selected connection object
  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId]
  );

  // All entities for the selected connection
  const connectionEntities = useMemo(() => {
    if (!selectedConnection?.data) return [];
    return [...config.getEntitiesFromData(selectedConnection.data)].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [selectedConnection, config]);

  // Available entities = connection entities minus already-added ones
  const availableEntities = useMemo(
    () => connectionEntities.filter((e) => !addedEntities.has(e.id)),
    [connectionEntities, addedEntities]
  );

  // --- Helpers ---

  const getEntityAccess = useCallback(
    (entityId: string): OperationFlags => {
      const entity = connectionEntities.find((e) => e.id === entityId);
      if (!entity?.access) return { ...fullAccess };
      return { ...entity.access };
    },
    [connectionEntities, fullAccess]
  );

  /** Clamp desired operations to what the connection user can actually do. */
  function clampToAccess(desired: OperationFlags, access: OperationFlags): OperationFlags {
    const result: OperationFlags = {};
    for (const op of config.operations) {
      result[op] = desired[op] && access[op];
    }
    return result;
  }

  // --- Actions ---

  const setConnectionId = useCallback((id: string) => {
    setConnectionIdState(id);
    setAddedEntities(new Map());
    setAccessLevelState("read-only");
  }, []);

  const setAccessLevel = useCallback(
    (level: AccessLevel) => {
      setAccessLevelState(level);
      setAddedEntities((prev) => {
        const desired = operationsForAccessLevel(level, config.operations);
        const next = new Map<string, OperationFlags>();
        for (const [entityId] of prev) {
          const access = getEntityAccess(entityId);
          next.set(entityId, clampToAccess(desired, access));
        }
        return next;
      });
    },
    [getEntityAccess, config.operations]
  );

  const addEntity = useCallback(
    (entityId: string) => {
      setAddedEntities((prev) => {
        if (prev.has(entityId)) return prev;
        const desired = operationsForAccessLevel(accessLevel, config.operations);
        const access = getEntityAccess(entityId);
        const next = new Map(prev);
        next.set(entityId, clampToAccess(desired, access));
        return next;
      });
    },
    [accessLevel, getEntityAccess, config.operations]
  );

  const addAllEntities = useCallback(() => {
    setAddedEntities((prev) => {
      const next = new Map(prev);
      const desired = operationsForAccessLevel(accessLevel, config.operations);
      for (const e of connectionEntities) {
        if (!next.has(e.id)) {
          const access = getEntityAccess(e.id);
          next.set(e.id, clampToAccess(desired, access));
        }
      }
      return next;
    });
  }, [connectionEntities, accessLevel, getEntityAccess, config.operations]);

  const removeEntity = useCallback((entityId: string) => {
    setAddedEntities((prev) => {
      const next = new Map(prev);
      next.delete(entityId);
      return next;
    });
  }, []);

  const toggleOperation = useCallback(
    (entityId: string, operation: string) => {
      setAddedEntities((prev) => {
        const flags = prev.get(entityId);
        if (!flags) return prev;

        // If trying to toggle ON but access doesn't allow it, no-op
        if (!flags[operation]) {
          const access = getEntityAccess(entityId);
          if (!access[operation]) return prev;
        }

        const next = new Map(prev);
        const updated = { ...flags, [operation]: !flags[operation] };
        next.set(entityId, updated);

        // Re-detect access level
        const detected = detectAccessLevelFromEntities(next, config.operations);
        setAccessLevelState(detected);

        return next;
      });
    },
    [getEntityAccess, config.operations]
  );

  // --- Output ---

  const getPermissions = useCallback((): Array<{
    model: string;
    operation: string;
  }> => {
    const perms: Array<{ model: string; operation: string }> = [];
    for (const [entityId, ops] of addedEntities) {
      for (const op of config.operations) {
        if (ops[op]) {
          perms.push({ model: entityId, operation: op });
        }
      }
    }
    return perms;
  }, [addedEntities, config.operations]);

  const isDirty = useMemo(() => {
    if (loading) return false;

    // No entities added and none initially → not configured, not dirty
    if (addedEntities.size === 0 && initialPermissions.current.size === 0) return false;

    if (connectionId !== initialConnectionId.current) return true;

    const currentSet = new Set<string>();
    for (const [entityId, ops] of addedEntities) {
      for (const op of config.operations) {
        if (ops[op]) {
          currentSet.add(`${entityId}:${op}`);
        }
      }
    }

    if (currentSet.size !== initialPermissions.current.size) return true;
    for (const key of currentSet) {
      if (!initialPermissions.current.has(key)) return true;
    }
    return false;
  }, [loading, connectionId, addedEntities, config.operations]);

  return {
    connections,
    connectionId,
    accessLevel,
    addedEntities,
    availableEntities,
    loading,

    setConnectionId,
    setAccessLevel,
    addEntity,
    addAllEntities,
    removeEntity,
    toggleOperation,

    getEntityAccess,
    getPermissions,
    isDirty,
  };
}
