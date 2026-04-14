import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useIntegrationPermissions,
  operationsForAccessLevel,
  detectAccessLevelFromEntities,
  type IntegrationPermissionsConfig,
} from "../use-integration-permissions";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// --- Pipedrive config (uses "update" instead of "write") ---
const PIPEDRIVE_CONFIG: IntegrationPermissionsConfig = {
  type: "pipedrive",
  operations: ["read", "create", "update", "delete"],
  getEntitiesFromData: (data) => {
    const d = data as {
      entities?: Array<{
        entity: string;
        name: string;
        category?: string;
        access?: Record<string, boolean>;
      }>;
    };
    return (d?.entities ?? []).map((e) => ({
      id: e.entity,
      name: e.name,
      category: e.category,
      access: e.access,
    }));
  },
};

// --- Odoo config (uses "write" instead of "update") ---
const ODOO_CONFIG: IntegrationPermissionsConfig = {
  type: "odoo",
  operations: ["read", "create", "write", "delete"],
  getEntitiesFromData: (data) => {
    const d = data as {
      models?: Array<{
        model: string;
        name: string;
        access?: Record<string, boolean>;
      }>;
    };
    return (d?.models ?? []).map((m) => ({
      id: m.model,
      name: m.name,
      access: m.access,
    }));
  },
};

// --- Test data ---

function makePipedriveConnection(
  id: string,
  name: string,
  entities?: Array<{
    entity: string;
    name: string;
    category?: string;
    access?: Record<string, boolean>;
  }>
) {
  return {
    id,
    name,
    type: "pipedrive",
    data: entities ? { entities } : null,
  };
}

function makeOdooConnection(
  id: string,
  name: string,
  models?: Array<{
    model: string;
    name: string;
    access?: Record<string, boolean>;
  }>
) {
  return {
    id,
    name,
    type: "odoo",
    data: models ? { models } : null,
  };
}

const PIPEDRIVE_ENTITIES = [
  {
    entity: "deals",
    name: "Deals",
    category: "Sales",
    access: { read: true, create: true, update: true, delete: false },
  },
  {
    entity: "persons",
    name: "Persons",
    category: "Contacts",
    access: { read: true, create: true, update: true, delete: true },
  },
  {
    entity: "activities",
    name: "Activities",
    category: "Activities",
    access: { read: true, create: false, update: false, delete: false },
  },
];

const ODOO_MODELS = [
  {
    model: "sale.order",
    name: "Sale Orders",
    access: { read: true, create: true, write: true, delete: false },
  },
  {
    model: "res.partner",
    name: "Contacts",
    access: { read: true, create: true, write: true, delete: true },
  },
];

const PIPEDRIVE_CONNECTIONS = [
  makePipedriveConnection("pd-1", "My Pipedrive", PIPEDRIVE_ENTITIES),
  makePipedriveConnection("pd-2", "Other Pipedrive", [
    { entity: "persons", name: "Persons", category: "Contacts" },
  ]),
];

const MIXED_CONNECTIONS = [
  ...PIPEDRIVE_CONNECTIONS,
  makeOdooConnection("odoo-1", "My Odoo", ODOO_MODELS),
];

function mockFetchResponses(
  connections: unknown[] = PIPEDRIVE_CONNECTIONS,
  agentPerms: unknown[] = []
) {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/integrations") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(connections),
      });
    }
    if (url.match(/\/api\/agents\/.*\/integrations/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(agentPerms),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

// --- Tests ---

describe("operationsForAccessLevel", () => {
  it("returns only first operation enabled for read-only", () => {
    const ops = ["read", "create", "update", "delete"];
    const flags = operationsForAccessLevel("read-only", ops);
    expect(flags).toEqual({ read: true, create: false, update: false, delete: false });
  });

  it("returns all except last operation for read-write", () => {
    const ops = ["read", "create", "update", "delete"];
    const flags = operationsForAccessLevel("read-write", ops);
    expect(flags).toEqual({ read: true, create: true, update: true, delete: false });
  });

  it("returns all operations enabled for full", () => {
    const ops = ["read", "create", "update", "delete"];
    const flags = operationsForAccessLevel("full", ops);
    expect(flags).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it("returns only first operation enabled for custom", () => {
    const ops = ["read", "create", "update", "delete"];
    const flags = operationsForAccessLevel("custom", ops);
    expect(flags).toEqual({ read: true, create: false, update: false, delete: false });
  });

  it("works with Odoo operations (write instead of update)", () => {
    const ops = ["read", "create", "write", "delete"];
    const flags = operationsForAccessLevel("read-write", ops);
    expect(flags).toEqual({ read: true, create: true, write: true, delete: false });
  });
});

describe("detectAccessLevelFromEntities", () => {
  it("returns read-only for empty map", () => {
    const result = detectAccessLevelFromEntities(new Map(), ["read", "create", "update", "delete"]);
    expect(result).toBe("read-only");
  });

  it("detects read-only when all entities have only read", () => {
    const map = new Map([
      ["deals", { read: true, create: false, update: false, delete: false }],
      ["persons", { read: true, create: false, update: false, delete: false }],
    ]);
    const result = detectAccessLevelFromEntities(map, ["read", "create", "update", "delete"]);
    expect(result).toBe("read-only");
  });

  it("detects read-write when all entities have read+create+update", () => {
    const map = new Map([
      ["deals", { read: true, create: true, update: true, delete: false }],
      ["persons", { read: true, create: true, update: true, delete: false }],
    ]);
    const result = detectAccessLevelFromEntities(map, ["read", "create", "update", "delete"]);
    expect(result).toBe("read-write");
  });

  it("detects full when all entities have all operations", () => {
    const map = new Map([["deals", { read: true, create: true, update: true, delete: true }]]);
    const result = detectAccessLevelFromEntities(map, ["read", "create", "update", "delete"]);
    expect(result).toBe("full");
  });

  it("detects custom when entities have mixed operations", () => {
    const map = new Map([
      ["deals", { read: true, create: true, update: false, delete: false }],
      ["persons", { read: true, create: false, update: true, delete: false }],
    ]);
    const result = detectAccessLevelFromEntities(map, ["read", "create", "update", "delete"]);
    expect(result).toBe("custom");
  });

  it("works with Odoo operations (write instead of update)", () => {
    const map = new Map([["sale.order", { read: true, create: true, write: true, delete: false }]]);
    const result = detectAccessLevelFromEntities(map, ["read", "create", "write", "delete"]);
    expect(result).toBe("read-write");
  });
});

describe("useIntegrationPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Connection loading & filtering ---

  it("loads and filters connections by config type", async () => {
    mockFetchResponses(MIXED_CONNECTIONS);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));

    expect(result.current.loading).toBe(true);
    await act(async () => {});

    expect(result.current.loading).toBe(false);
    // Should only have pipedrive connections, not odoo
    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections.every((c) => c.type === "pipedrive")).toBe(true);
  });

  it("loads and filters connections for odoo config", async () => {
    mockFetchResponses(MIXED_CONNECTIONS);

    const { result } = renderHook(() => useIntegrationPermissions(ODOO_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].type).toBe("odoo");
  });

  // --- Permission loading ---

  it("loads existing permissions filtered by connection type", async () => {
    mockFetchResponses(MIXED_CONNECTIONS, [
      {
        connectionId: "odoo-1",
        connectionName: "My Odoo",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [
          { model: "deals", modelName: "Deals", operation: "read" },
          { model: "deals", modelName: "Deals", operation: "create" },
        ],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    // Should load the pipedrive permissions, not odoo
    expect(result.current.connectionId).toBe("pd-1");
    expect(result.current.addedEntities.size).toBe(1);
    expect(result.current.addedEntities.has("deals")).toBe(true);
  });

  it("loads existing permissions on mount", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [
          { model: "deals", modelName: "Deals", operation: "read" },
          { model: "deals", modelName: "Deals", operation: "create" },
          { model: "persons", modelName: "Persons", operation: "read" },
        ],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.connectionId).toBe("pd-1");
    expect(result.current.addedEntities.size).toBe(2);

    const deals = result.current.addedEntities.get("deals");
    expect(deals).toEqual({ read: true, create: true, update: false, delete: false });

    const persons = result.current.addedEntities.get("persons");
    expect(persons).toEqual({ read: true, create: false, update: false, delete: false });
  });

  // --- Connection switching ---

  it("resets entities and access level when connection changes", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [{ model: "deals", modelName: "Deals", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.addedEntities.size).toBe(1);

    act(() => {
      result.current.setConnectionId("pd-2");
    });

    expect(result.current.connectionId).toBe("pd-2");
    expect(result.current.addedEntities.size).toBe(0);
    expect(result.current.accessLevel).toBe("read-only");
  });

  // --- Access Levels with Pipedrive operations ---

  it("setAccessLevel('read-only') sets all entities to read only", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => {
      result.current.addEntity("deals");
      result.current.addEntity("persons");
    });
    act(() => result.current.setAccessLevel("full"));
    act(() => result.current.setAccessLevel("read-only"));

    expect(result.current.accessLevel).toBe("read-only");
    for (const [, ops] of result.current.addedEntities) {
      expect(ops).toEqual({ read: true, create: false, update: false, delete: false });
    }
  });

  it("setAccessLevel('read-write') sets all operations except delete", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("persons"));
    act(() => result.current.setAccessLevel("read-write"));

    expect(result.current.accessLevel).toBe("read-write");
    const ops = result.current.addedEntities.get("persons");
    expect(ops).toEqual({ read: true, create: true, update: true, delete: false });
  });

  it("setAccessLevel('full') sets all operations", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("persons"));
    act(() => result.current.setAccessLevel("full"));

    expect(result.current.accessLevel).toBe("full");
    const ops = result.current.addedEntities.get("persons");
    expect(ops).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it("detects access level from existing permissions on load", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [
          { model: "deals", modelName: "Deals", operation: "read" },
          { model: "deals", modelName: "Deals", operation: "create" },
          { model: "deals", modelName: "Deals", operation: "update" },
          { model: "persons", modelName: "Persons", operation: "read" },
          { model: "persons", modelName: "Persons", operation: "create" },
          { model: "persons", modelName: "Persons", operation: "update" },
        ],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("read-write");
  });

  it("detects 'custom' access level when entities have mixed operations", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [
          { model: "deals", modelName: "Deals", operation: "read" },
          { model: "deals", modelName: "Deals", operation: "delete" },
          { model: "persons", modelName: "Persons", operation: "read" },
        ],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("custom");
  });

  // --- Add/Remove Entities ---

  it("addEntity adds entity with flags based on current access level", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));

    // Default access level is read-only
    act(() => result.current.addEntity("deals"));
    expect(result.current.addedEntities.get("deals")).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
    });

    // Change to full, then add another
    act(() => result.current.setAccessLevel("full"));
    act(() => result.current.addEntity("persons"));
    expect(result.current.addedEntities.get("persons")).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
    });
  });

  it("addAllEntities adds all available entities", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("deals"));
    act(() => result.current.addAllEntities());

    expect(result.current.addedEntities.size).toBe(3);
    expect(result.current.addedEntities.has("deals")).toBe(true);
    expect(result.current.addedEntities.has("persons")).toBe(true);
    expect(result.current.addedEntities.has("activities")).toBe(true);
  });

  it("removeEntity removes an entity", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => {
      result.current.addEntity("deals");
      result.current.addEntity("persons");
    });
    act(() => result.current.removeEntity("deals"));

    expect(result.current.addedEntities.size).toBe(1);
    expect(result.current.addedEntities.has("deals")).toBe(false);
    expect(result.current.addedEntities.has("persons")).toBe(true);
  });

  it("availableEntities excludes already-added entities", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));

    expect(result.current.availableEntities).toHaveLength(3);

    act(() => result.current.addEntity("deals"));

    expect(result.current.availableEntities).toHaveLength(2);
    expect(result.current.availableEntities.find((e) => e.id === "deals")).toBeUndefined();
  });

  // --- Toggle Operations ---

  it("toggleOperation toggles a single operation", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("deals"));

    expect(result.current.addedEntities.get("deals")!.create).toBe(false);

    act(() => result.current.toggleOperation("deals", "create"));
    expect(result.current.addedEntities.get("deals")!.create).toBe(true);

    act(() => result.current.toggleOperation("deals", "create"));
    expect(result.current.addedEntities.get("deals")!.create).toBe(false);
  });

  it("toggleOperation switches access level to custom when it diverges from preset", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => {
      result.current.addEntity("deals");
      result.current.addEntity("persons");
    });
    act(() => result.current.setAccessLevel("read-write"));
    expect(result.current.accessLevel).toBe("read-write");

    act(() => result.current.toggleOperation("deals", "update"));
    expect(result.current.accessLevel).toBe("custom");
  });

  it("toggleOperation detects when operations match a preset again", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("deals"));

    // Start at read-only, toggle create+update on → read-write
    act(() => result.current.toggleOperation("deals", "create"));
    act(() => result.current.toggleOperation("deals", "update"));

    expect(result.current.accessLevel).toBe("read-write");
  });

  // --- Access Restrictions ---

  it("addEntity respects access restrictions", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.setAccessLevel("read-write"));

    // activities has create=false, update=false in access restrictions
    act(() => result.current.addEntity("activities"));

    const ops = result.current.addedEntities.get("activities");
    expect(ops).toEqual({ read: true, create: false, update: false, delete: false });
  });

  it("setAccessLevel respects access restrictions", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => {
      result.current.addEntity("deals");
      result.current.addEntity("persons");
    });

    act(() => result.current.setAccessLevel("full"));

    // deals has delete=false, so delete should stay false
    const deals = result.current.addedEntities.get("deals");
    expect(deals).toEqual({ read: true, create: true, update: true, delete: false });

    // persons has full access
    const persons = result.current.addedEntities.get("persons");
    expect(persons).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it("toggleOperation is no-op for restricted operations", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("activities"));

    // activities has create=false in access
    act(() => result.current.toggleOperation("activities", "create"));
    expect(result.current.addedEntities.get("activities")!.create).toBe(false);
  });

  it("addAllEntities respects per-entity access restrictions", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.setAccessLevel("full"));
    act(() => result.current.addAllEntities());

    // deals: delete=false in access
    expect(result.current.addedEntities.get("deals")).toEqual({
      read: true,
      create: true,
      update: true,
      delete: false,
    });

    // persons: full access
    expect(result.current.addedEntities.get("persons")).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
    });

    // activities: only read allowed
    expect(result.current.addedEntities.get("activities")).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
    });
  });

  it("getEntityAccess returns full access for entities without access field", async () => {
    const entitiesWithoutAccess = [{ entity: "deals", name: "Deals" }];
    mockFetchResponses([makePipedriveConnection("pd-legacy", "Legacy", entitiesWithoutAccess)]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-legacy"));

    const access = result.current.getEntityAccess("deals");
    expect(access).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it("addAllEntities does not re-add already existing entities", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.setAccessLevel("full"));
    act(() => result.current.addEntity("persons"));

    // Toggle off delete → access level re-detects as read-write
    act(() => result.current.toggleOperation("persons", "delete"));
    expect(result.current.accessLevel).toBe("read-write");

    // addAllEntities should NOT overwrite customized persons
    act(() => result.current.addAllEntities());

    const persons = result.current.addedEntities.get("persons");
    expect(persons!.delete).toBe(false);

    // deals gets read-write ops clamped by its access (delete=false anyway)
    const deals = result.current.addedEntities.get("deals");
    expect(deals).toEqual({ read: true, create: true, update: true, delete: false });
  });

  // --- Output ---

  it("getPermissions returns flat array of {model, operation} tuples", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("deals"));
    act(() => result.current.setAccessLevel("read-write"));

    const perms = result.current.getPermissions();
    expect(perms).toEqual(
      expect.arrayContaining([
        { model: "deals", operation: "read" },
        { model: "deals", operation: "create" },
        { model: "deals", operation: "update" },
      ])
    );
    expect(perms).toHaveLength(3);
  });

  it("getPermissions returns empty array when no entities added", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    expect(result.current.getPermissions()).toEqual([]);
  });

  // --- Dirty state ---

  it("isDirty is false when no entities added and none loaded", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);

    act(() => result.current.setConnectionId("pd-1"));
    expect(result.current.isDirty).toBe(false);
  });

  it("isDirty is true when entities added", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-1"));
    act(() => result.current.addEntity("deals"));

    expect(result.current.isDirty).toBe(true);
  });

  it("isDirty is false when loaded permissions match current state", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [{ model: "deals", modelName: "Deals", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);
  });

  it("isDirty is true when connection changes from initial", async () => {
    mockFetchResponses(PIPEDRIVE_CONNECTIONS, [
      {
        connectionId: "pd-1",
        connectionName: "My Pipedrive",
        connectionType: "pipedrive",
        permissions: [{ model: "deals", modelName: "Deals", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-2"));
    act(() => result.current.addEntity("persons"));

    expect(result.current.isDirty).toBe(true);
  });

  // --- Edge cases ---

  it("no connections returns empty state", async () => {
    mockFetchResponses([], []);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    expect(result.current.connections).toHaveLength(0);
    expect(result.current.availableEntities).toHaveLength(0);
  });

  it("connection without synced entities returns empty entities", async () => {
    mockFetchResponses([makePipedriveConnection("pd-empty", "Empty", undefined)], []);

    const { result } = renderHook(() => useIntegrationPermissions(PIPEDRIVE_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("pd-empty"));

    expect(result.current.availableEntities).toHaveLength(0);
  });

  // --- Odoo config via generic hook ---

  it("works with Odoo config (write instead of update)", async () => {
    mockFetchResponses([makeOdooConnection("odoo-1", "My Odoo", ODOO_MODELS)]);
    const { result } = renderHook(() => useIntegrationPermissions(ODOO_CONFIG, "agent-1"));
    await act(async () => {});

    act(() => result.current.setConnectionId("odoo-1"));
    act(() => result.current.addEntity("sale.order"));
    act(() => result.current.setAccessLevel("read-write"));

    const ops = result.current.addedEntities.get("sale.order");
    expect(ops).toEqual({ read: true, create: true, write: true, delete: false });

    const perms = result.current.getPermissions();
    expect(perms).toEqual(
      expect.arrayContaining([
        { model: "sale.order", operation: "read" },
        { model: "sale.order", operation: "create" },
        { model: "sale.order", operation: "write" },
      ])
    );
    expect(perms).toHaveLength(3);
  });
});
