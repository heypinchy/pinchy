import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOdooPermissions, type Connection } from "../use-odoo-permissions";

// Mock fetch — only used for /api/agents/:id/integrations (per-agent permissions)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConnection(
  id: string,
  name: string,
  models?: Array<{
    model: string;
    name: string;
    access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
  }>
): Connection {
  return {
    id,
    name,
    type: "odoo",
    data: models ? { models } : null,
  };
}

const SAMPLE_MODELS = [
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
  {
    model: "account.move",
    name: "Invoices",
    access: { read: true, create: false, write: false, delete: false },
  },
];

const CONNECTIONS: Connection[] = [
  makeConnection("conn-1", "Staging", SAMPLE_MODELS),
  makeConnection("conn-2", "Production", [{ model: "res.partner", name: "Contacts" }]),
];

function mockAgentPerms(agentPerms: unknown[] = []) {
  mockFetch.mockImplementation((url: string) => {
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

  it("uses the connections passed as an argument", async () => {
    mockAgentPerms();

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));

    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.loading).toBe(false);
    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections[0].name).toBe("Staging");
  });

  it("loads existing permissions on mount", async () => {
    mockAgentPerms([
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

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.connectionId).toBe("conn-1");
    expect(result.current.addedModels.size).toBe(2);

    const saleOrder = result.current.addedModels.get("sale.order");
    expect(saleOrder).toEqual({ read: true, create: true, write: false, delete: false });

    const partner = result.current.addedModels.get("res.partner");
    expect(partner).toEqual({ read: true, create: false, write: false, delete: false });
  });

  it("ignores permissions for non-odoo connections (e.g. email)", async () => {
    mockAgentPerms([
      {
        connectionId: "email-conn-1",
        connectionName: "Gmail",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1", []));
    await act(async () => {});

    expect(result.current.connectionId).toBe("");
    expect(result.current.addedModels.size).toBe(0);
    expect(result.current.getPermissions()).toEqual([]);
  });

  it("picks the odoo entry when both email and odoo permissions exist", async () => {
    mockAgentPerms([
      {
        connectionId: "email-conn-1",
        connectionName: "Gmail",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.connectionId).toBe("conn-1");
    expect(result.current.addedModels.size).toBe(1);
    expect(result.current.addedModels.has("sale.order")).toBe(true);
  });

  it("resets models and access level when connection changes", async () => {
    mockAgentPerms([
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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

    act(() => {
      result.current.setAccessLevel("read-only");
    });

    expect(result.current.accessLevel).toBe("read-only");
    for (const [, ops] of result.current.addedModels) {
      expect(ops).toEqual({ read: true, create: false, write: false, delete: false });
    }
  });

  it("setAccessLevel('read-write') sets all added models to read, create, write", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("res.partner");
    });

    act(() => {
      result.current.setAccessLevel("full");
    });

    expect(result.current.accessLevel).toBe("full");
    const ops = result.current.addedModels.get("res.partner");
    expect(ops).toEqual({ read: true, create: true, write: true, delete: true });
  });

  it("detects access level from existing permissions on load", async () => {
    mockAgentPerms([
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

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("read-write");
  });

  it("detects 'custom' access level when models have mixed operations", async () => {
    mockAgentPerms([
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

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.accessLevel).toBe("custom");
  });

  // --- Add/Remove Models ---

  it("addModel adds a model with operations based on current access level", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.addedModels.get("sale.order")).toEqual({
      read: true,
      create: false,
      write: false,
      delete: false,
    });

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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    act(() => {
      result.current.addAllModels();
    });

    expect(result.current.addedModels.size).toBe(3);
    expect(result.current.addedModels.has("sale.order")).toBe(true);
    expect(result.current.addedModels.has("res.partner")).toBe(true);
    expect(result.current.addedModels.has("account.move")).toBe(true);
  });

  it("removeModel removes a model", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    expect(result.current.availableModels).toHaveLength(3);

    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.availableModels).toHaveLength(2);
    expect(result.current.availableModels.find((m) => m.model === "sale.order")).toBeUndefined();
  });

  // --- Toggle Operations ---

  it("toggleOperation toggles a single operation", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    expect(result.current.addedModels.get("sale.order")!.create).toBe(false);

    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    expect(result.current.addedModels.get("sale.order")!.create).toBe(true);

    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    expect(result.current.addedModels.get("sale.order")!.create).toBe(false);
  });

  it("toggleOperation switches access level to custom when it diverges from preset", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
      result.current.addModel("res.partner");
    });

    act(() => {
      result.current.setAccessLevel("read-write");
    });

    expect(result.current.accessLevel).toBe("read-write");

    act(() => {
      result.current.toggleOperation("sale.order", "write");
    });

    expect(result.current.accessLevel).toBe("custom");
  });

  it("toggleOperation detects when operations match a preset again", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("sale.order");
    });

    act(() => {
      result.current.toggleOperation("sale.order", "create");
    });

    act(() => {
      result.current.toggleOperation("sale.order", "write");
    });

    expect(result.current.accessLevel).toBe("read-write");
  });

  // --- Output ---

  it("getPermissions returns flat array of {model, operation} tuples", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    expect(result.current.isDirty).toBe(false);
  });

  it("isDirty is true when connection selected AND models added", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    expect(result.current.getPermissions()).toEqual([]);
  });

  it("isDirty is false when loaded permissions match current state", async () => {
    mockAgentPerms([
      {
        connectionId: "conn-1",
        connectionName: "Staging",
        connectionType: "odoo",
        permissions: [{ model: "sale.order", modelName: "Sale Orders", operation: "read" }],
      },
    ]);

    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    expect(result.current.isDirty).toBe(false);
  });

  // --- Edge cases ---

  it("no connections returns empty state", async () => {
    mockAgentPerms();

    const { result } = renderHook(() => useOdooPermissions("agent-1", []));
    await act(async () => {});

    expect(result.current.connections).toHaveLength(0);
    expect(result.current.availableModels).toHaveLength(0);
  });

  it("connection without synced models returns empty models", async () => {
    mockAgentPerms();

    const { result } = renderHook(() =>
      useOdooPermissions("agent-1", [makeConnection("conn-no-models", "No Models", undefined)])
    );
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-no-models");
    });

    expect(result.current.availableModels).toHaveLength(0);
  });

  // --- Access restrictions ---

  it("addModel respects access restrictions", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.setAccessLevel("read-write");
    });

    act(() => {
      result.current.addModel("account.move");
    });

    const ops = result.current.addedModels.get("account.move");
    expect(ops).toEqual({ read: true, create: false, write: false, delete: false });
  });

  it("setAccessLevel respects access restrictions", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
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

    const saleOrder = result.current.addedModels.get("sale.order");
    expect(saleOrder).toEqual({ read: true, create: true, write: true, delete: false });

    const partner = result.current.addedModels.get("res.partner");
    expect(partner).toEqual({ read: true, create: true, write: true, delete: true });
  });

  it("toggleOperation is no-op for restricted operations", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.addModel("account.move");
    });

    act(() => {
      result.current.toggleOperation("account.move", "create");
    });

    expect(result.current.addedModels.get("account.move")!.create).toBe(false);
  });

  it("addAllModels respects per-model access restrictions", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.setAccessLevel("full");
    });

    act(() => {
      result.current.addAllModels();
    });

    expect(result.current.addedModels.get("sale.order")).toEqual({
      read: true,
      create: true,
      write: true,
      delete: false,
    });

    expect(result.current.addedModels.get("res.partner")).toEqual({
      read: true,
      create: true,
      write: true,
      delete: true,
    });

    expect(result.current.addedModels.get("account.move")).toEqual({
      read: true,
      create: false,
      write: false,
      delete: false,
    });
  });

  it("getModelAccess returns full access for models without access field", async () => {
    mockAgentPerms();
    const modelsWithoutAccess = [{ model: "sale.order", name: "Sale Orders" }];

    const { result } = renderHook(() =>
      useOdooPermissions("agent-1", [makeConnection("conn-legacy", "Legacy", modelsWithoutAccess)])
    );
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-legacy");
    });

    const access = result.current.getModelAccess("sale.order");
    expect(access).toEqual({ read: true, create: true, write: true, delete: true });
  });

  it("addAllModels does not re-add already existing models", async () => {
    mockAgentPerms();
    const { result } = renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    act(() => {
      result.current.setConnectionId("conn-1");
    });

    act(() => {
      result.current.setAccessLevel("full");
    });

    act(() => {
      result.current.addModel("res.partner");
    });

    act(() => {
      result.current.toggleOperation("res.partner", "delete");
    });

    expect(result.current.accessLevel).toBe("read-write");

    act(() => {
      result.current.addAllModels();
    });

    const partner = result.current.addedModels.get("res.partner");
    expect(partner!.delete).toBe(false);

    const saleOrder = result.current.addedModels.get("sale.order");
    expect(saleOrder).toEqual({ read: true, create: true, write: true, delete: false });
  });

  it("does not call /api/integrations (connections come from argument)", async () => {
    mockAgentPerms();

    renderHook(() => useOdooPermissions("agent-1", CONNECTIONS));
    await act(async () => {});

    const calls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(calls).not.toContain("/api/integrations");
  });
});
