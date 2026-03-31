import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOdooPermissions } from "../use-odoo-permissions";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConnection(id: string, name: string, models?: Array<{ model: string; name: string }>) {
  return {
    id,
    name,
    type: "odoo",
    data: models ? { models } : null,
  };
}

const SAMPLE_MODELS = [
  { model: "sale.order", name: "Sale Orders" },
  { model: "res.partner", name: "Contacts" },
  { model: "account.move", name: "Invoices" },
];

const CONNECTIONS = [
  makeConnection("conn-1", "Staging", SAMPLE_MODELS),
  makeConnection("conn-2", "Production", [{ model: "res.partner", name: "Contacts" }]),
];

function mockFetchResponses(connections: unknown[] = CONNECTIONS, agentPerms: unknown[] = []) {
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

describe("useOdooPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Connection loading ---

  it("loads connections on mount", async () => {
    mockFetchResponses();

    const { result } = renderHook(() => useOdooPermissions("agent-1"));

    // Should be loading initially
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.loading).toBe(false);
    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections[0].name).toBe("Staging");
  });

  it("loads existing permissions on mount", async () => {
    mockFetchResponses(CONNECTIONS, [
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [
          { model: "sale.order", modelName: "Sale Orders", operation: "read" },
          { model: "sale.order", modelName: "Sale Orders", operation: "create" },
          { model: "res.partner", modelName: "Contacts", operation: "read" },
        ],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.connectionId).toBe("conn-1");
    expect(result.current.addedModels.size).toBe(2);

    const saleOrder = result.current.addedModels.get("sale.order");
    expect(saleOrder).toEqual({ read: true, create: true, write: false, delete: false });

    const partner = result.current.addedModels.get("res.partner");
    expect(partner).toEqual({ read: true, create: false, write: false, delete: false });
  });

  it("resets models and access level when connection changes", async () => {
    mockFetchResponses(CONNECTIONS, [
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.addedModels.size).toBe(1);

    act(() => {
      result.current.setConnectionId("conn-2");
    });

    expect(result.current.connectionId).toBe("conn-2");
    expect(result.current.addedModels.size).toBe(0);
    expect(result.current.accessLevel).toBe("read-only");
  });

  // --- Access Level ---

  it("setAccessLevel('read-only') sets all added models to read only", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
      result.current.addModel("res.partner");
    });

    act(() => {
      result.current.setAccessLevel("full");
    });

    // Now switch to read-only
    act(() => {
      result.current.setAccessLevel("read-only");
    });

    expect(result.current.accessLevel).toBe("read-only");
    for (const [, ops] of result.current.addedModels) {
      expect(ops).toEqual({ read: true, create: false, write: false, delete: false });
    }
  });

  it("setAccessLevel('read-write') sets all added models to read, create, write", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    act(() => {
      result.current.setAccessLevel("read-write");
    });

    expect(result.current.accessLevel).toBe("read-write");
    const ops = result.current.addedModels.get("sale.order");
    expect(ops).toEqual({ read: true, create: true, write: true, delete: false });
  });

  it("setAccessLevel('full') sets all added models to all operations", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    act(() => {
      result.current.setAccessLevel("full");
    });

    expect(result.current.accessLevel).toBe("full");
    const ops = result.current.addedModels.get("sale.order");
    expect(ops).toEqual({ read: true, create: true, write: true, delete: true });
  });

  it("detects access level from existing permissions on load", async () => {
    // All models have read+create+write → read-write
    mockFetchResponses(CONNECTIONS, [
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [
          { model: "sale.order", modelName: "Sale Orders", operation: "read" },
          { model: "sale.order", modelName: "Sale Orders", operation: "create" },
          { model: "sale.order", modelName: "Sale Orders", operation: "write" },
          { model: "res.partner", modelName: "Contacts", operation: "read" },
          { model: "res.partner", modelName: "Contacts", operation: "create" },
          { model: "res.partner", modelName: "Contacts", operation: "write" },
        ],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("read-write");
  });

  it("detects 'custom' access level when models have mixed operations", async () => {
    mockFetchResponses(CONNECTIONS, [
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [
          { model: "sale.order", modelName: "Sale Orders", operation: "read" },
          { model: "sale.order", modelName: "Sale Orders", operation: "delete" },
          { model: "res.partner", modelName: "Contacts", operation: "read" },
        ],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("custom");
  });

  // --- Add/Remove Models ---

  it("addModel adds a model with operations based on current access level", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    // Default access level is read-only
    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.addedModels.get("sale.order")).toEqual({
      read: true,
      create: false,
      write: false,
      delete: false,
    });

    // Change to full, then add another
    act(() => {
      result.current.setAccessLevel("full");
    });

    act(() => {
      result.current.addModel("res.partner");
    });

    expect(result.current.addedModels.get("res.partner")).toEqual({
      read: true,
      create: true,
      write: true,
      delete: true,
    });
  });

  it("addAllModels adds all available models", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    // Add one model first
    act(() => {
      result.current.addModel("sale.order");
    });

    // Now add all — should add the remaining ones
    act(() => {
      result.current.addAllModels();
    });

    expect(result.current.addedModels.size).toBe(3);
    expect(result.current.addedModels.has("sale.order")).toBe(true);
    expect(result.current.addedModels.has("res.partner")).toBe(true);
    expect(result.current.addedModels.has("account.move")).toBe(true);
  });

  it("removeModel removes a model", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
      result.current.addModel("res.partner");
    });

    act(() => {
      result.current.removeModel("sale.order");
    });

    expect(result.current.addedModels.size).toBe(1);
    expect(result.current.addedModels.has("sale.order")).toBe(false);
    expect(result.current.addedModels.has("res.partner")).toBe(true);
  });

  it("availableModels excludes already-added models", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    // Initially all 3 are available
    expect(result.current.availableModels).toHaveLength(3);

    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.availableModels).toHaveLength(2);
    expect(result.current.availableModels.find((m) => m.model === "sale.order")).toBeUndefined();
  });

  // --- Toggle Operations ---

  it("toggleOperation toggles a single operation", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    // Initially read-only: read=true, create=false
    expect(result.current.addedModels.get("sale.order")!.create).toBe(false);

    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    expect(result.current.addedModels.get("sale.order")!.create).toBe(true);

    // Toggle back
    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    expect(result.current.addedModels.get("sale.order")!.create).toBe(false);
  });

  it("toggleOperation switches access level to custom when it diverges from preset", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
      result.current.addModel("res.partner");
    });

    // Set to read-write
    act(() => {
      result.current.setAccessLevel("read-write");
    });

    expect(result.current.accessLevel).toBe("read-write");

    // Now uncheck write on one model — should switch to custom
    act(() => {
      result.current.toggleOperation("sale.order", "write");
    });

    expect(result.current.accessLevel).toBe("custom");
  });

  it("toggleOperation detects when operations match a preset again", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    // Start at read-only, toggle create+write on
    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    act(() => {
      result.current.toggleOperation("sale.order", "write");
    });

    // Now all models have read+create+write → should detect read-write
    expect(result.current.accessLevel).toBe("read-write");
  });

  // --- Output ---

  it("getPermissions returns flat array of {model, operation} tuples", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    act(() => {
      result.current.setAccessLevel("read-write");
    });

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

  it("isDirty is false when connection selected but no models added", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    // Connection without models is not a saveable config → not dirty
    expect(result.current.isDirty).toBe(false);
  });

  it("isDirty is true when connection selected AND models added", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.isDirty).toBe(true);
  });

  it("getPermissions returns empty array when no models added", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    expect(result.current.getPermissions()).toEqual([]);
  });

  it("isDirty is false when loaded permissions match current state", async () => {
    mockFetchResponses(CONNECTIONS, [
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);
  });

  // --- Edge cases ---

  it("no connections returns empty state", async () => {
    mockFetchResponses([], []);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    expect(result.current.connections).toHaveLength(0);
    expect(result.current.availableModels).toHaveLength(0);
  });

  it("connection without synced models returns empty models", async () => {
    mockFetchResponses([makeConnection("conn-no-models", "No Models", undefined)], []);

    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-no-models");
    });

    expect(result.current.availableModels).toHaveLength(0);
  });

  it("addAllModels does not re-add already existing models", async () => {
    mockFetchResponses();
    const { result } = renderHook(() => useOdooPermissions("agent-1"));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    // Set to full, add one model
    act(() => {
      result.current.setAccessLevel("full");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    // Now toggle off delete on that model — access level re-detects as read-write
    act(() => {
      result.current.toggleOperation("sale.order", "delete");
    });

    expect(result.current.accessLevel).toBe("read-write");

    // addAllModels should NOT overwrite the customized sale.order
    act(() => {
      result.current.addAllModels();
    });

    // sale.order should still have custom ops (delete off)
    const saleOrder = result.current.addedModels.get("sale.order");
    expect(saleOrder!.delete).toBe(false);

    // New models get operations based on current access level (read-write)
    const partner = result.current.addedModels.get("res.partner");
    expect(partner).toEqual({ read: true, create: true, write: true, delete: false });
  });
});
