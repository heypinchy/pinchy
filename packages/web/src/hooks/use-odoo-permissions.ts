import {
  useIntegrationPermissions,
  operationsForAccessLevel as genericOperationsForAccessLevel,
  detectAccessLevelFromEntities,
  type IntegrationPermissionsConfig,
  type OperationFlags as GenericOperationFlags,
} from "./use-integration-permissions";
import type { OdooAccessLevel } from "@/lib/tool-registry";

// --- Odoo-specific types (preserved for backward compatibility) ---

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

// --- Odoo config for the generic hook ---

const ODOO_CONFIG: IntegrationPermissionsConfig = {
  type: "odoo",
  operations: OPERATIONS,
  getEntitiesFromData: (data) => {
    const d = data as {
      models?: Array<{ model: string; name: string; access?: Record<string, boolean> }>;
    };
    return (d?.models ?? []).map((m) => ({ id: m.model, name: m.name, access: m.access }));
  },
};

// --- Backward-compatible helper exports ---

/** Returns the default operation flags for a given access level. */
export function operationsForAccessLevel(level: OdooAccessLevel): OperationFlags {
  const generic = genericOperationsForAccessLevel(level, OPERATIONS);
  return generic as OperationFlags;
}

/** Detect access level from a set of models with their operations. */
export function detectAccessLevelFromModels(models: Map<string, OperationFlags>): OdooAccessLevel {
  return detectAccessLevelFromEntities(models as Map<string, GenericOperationFlags>, OPERATIONS);
}

// --- Return type (preserved for backward compatibility) ---

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

// --- Thin wrapper ---

export function useOdooPermissions(agentId: string): UseOdooPermissionsReturn {
  const generic = useIntegrationPermissions(ODOO_CONFIG, agentId);

  return {
    connections: generic.connections as Connection[],
    connectionId: generic.connectionId,
    accessLevel: generic.accessLevel as OdooAccessLevel,
    addedModels: generic.addedEntities as Map<string, OperationFlags>,
    availableModels: generic.availableEntities.map((e) => ({
      model: e.id,
      name: e.name,
      access: e.access as OperationFlags | undefined,
    })),
    loading: generic.loading,

    setConnectionId: generic.setConnectionId,
    setAccessLevel: (level: OdooAccessLevel) => generic.setAccessLevel(level),
    addModel: generic.addEntity,
    addAllModels: generic.addAllEntities,
    removeModel: generic.removeEntity,
    toggleOperation: (modelId: string, operation: Operation) =>
      generic.toggleOperation(modelId, operation),

    getModelAccess: (modelId: string) => generic.getEntityAccess(modelId) as OperationFlags,
    getPermissions: generic.getPermissions,
    isDirty: generic.isDirty,
  };
}
