import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFields = vi.fn();
const mockCheckAccessRights = vi.fn();

vi.mock("odoo-node", () => {
  return {
    OdooClient: class {
      fields = mockFields;
      checkAccessRights = mockCheckAccessRights;
    },
  };
});

import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";
import { fetchOdooSchema, getAccessibleCategoryLabels, MODEL_CATEGORIES } from "../odoo-sync";

const creds = { url: "https://odoo.example.com", db: "test", uid: 2, apiKey: "key" };

function syncedModelNames(): Set<string> {
  return new Set(MODEL_CATEGORIES.flatMap((category) => category.models.map((m) => m.model)));
}

describe("MODEL_CATEGORIES", () => {
  it("includes every Odoo template required model", () => {
    const syncedModels = syncedModelNames();
    const templateModels = new Set(
      Object.values(ODOO_TEMPLATES).flatMap((template) =>
        (template.odooConfig?.requiredModels ?? []).map((m) => m.model)
      )
    );

    const missing = [...templateModels].filter((model) => !syncedModels.has(model)).sort();

    expect(missing).toEqual([]);
  });

  it("includes supporting accounting models used when agents create invoices and bills", () => {
    const syncedModels = syncedModelNames();

    expect([...syncedModels].sort()).toEqual(
      expect.arrayContaining([
        "account.account",
        "account.journal",
        "account.payment.term",
        "account.tax",
        "res.currency",
      ])
    );
  });
});

describe("fetchOdooSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAccessRights.mockResolvedValue(true);
  });

  it("probes curated models via fields_get instead of ir.model", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char", required: true, readonly: false },
    ]);

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(mockFields).toHaveBeenCalled();
    expect(result.models).toBeGreaterThan(0);
  });

  it("includes ir.attachment so admins can grant receipt upload permissions", async () => {
    mockFields.mockImplementation((model: string) => {
      if (model === "ir.attachment") {
        return Promise.resolve([
          { name: "name", string: "Name", type: "char", required: true, readonly: false },
          {
            name: "datas",
            string: "File Content",
            type: "binary",
            required: false,
            readonly: false,
          },
          {
            name: "res_model",
            string: "Resource Model",
            type: "char",
            required: false,
            readonly: false,
          },
          {
            name: "res_id",
            string: "Resource ID",
            type: "integer",
            required: false,
            readonly: false,
          },
        ]);
      }
      return Promise.reject(new Error("AccessError"));
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.models.map((m) => m.model)).toContain("ir.attachment");
  });

  it("skips models the user has no access to", async () => {
    let callCount = 0;
    mockFields.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve([
          { name: "id", string: "ID", type: "integer", required: true, readonly: true },
        ]);
      }
      return Promise.reject(new Error("AccessError: no access"));
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.models).toBeGreaterThanOrEqual(1);
    expect(result.data.models.every((m) => m.fields.length > 0)).toBe(true);
  });

  it("returns error when no models are accessible at all", async () => {
    mockFields.mockRejectedValue(new Error("AccessError"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Could not access any Odoo models");
    expect(result.isAuthError).toBe(true);
  });

  it("returns isAuthError: false when all models fail due to transient errors", async () => {
    vi.useFakeTimers();
    mockFields.mockRejectedValue(new Error("ETIMEDOUT"));

    const promise = fetchOdooSchema(creds);
    // Advance past all retry delays (MAX_RETRIES=2: 500ms + 1000ms per model)
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.isAuthError).toBe(false);
    // The same transport failure on every model is the connection failing,
    // not missing permissions.
    expect(result.error).toBe("Could not reach Odoo: ETIMEDOUT");
  });

  it("says Odoo could not be reached when odoo-node reports a network failure", async () => {
    vi.useFakeTimers();
    // odoo-node's shape for a request that never got an answer: code 0.
    mockFields.mockRejectedValue(Object.assign(new Error("fetch failed"), { code: 0 }));

    const promise = fetchOdooSchema(creds);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Could not reach Odoo: fetch failed");
    expect(result.isAuthError).toBe(false);
  });

  it("words a shared HTTP failure after retries as true for an Odoo that was reached", async () => {
    vi.useFakeTimers();
    mockFields.mockRejectedValue(
      Object.assign(new Error("HTTP 429: Too Many Requests"), { code: 429 })
    );

    const promise = fetchOdooSchema(creds);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    // The status may come from a proxy in front of Odoo as much as from Odoo.
    expect(result.error).toBe(
      "The Odoo address answered with an error: HTTP 429: Too Many Requests"
    );
    expect(result.isAuthError).toBe(false);
  });

  const READ_ACCESS_MESSAGE =
    "Could not access any Odoo models. Please ensure the API user has at least " +
    "read access to the modules you want to use (e.g. Sales, Inventory, Contacts).";

  // No probe reported an access problem, so the message must not claim one.
  it("names the failures, not read access, when models fail for different reasons", async () => {
    mockFields.mockImplementation((model: string) =>
      Promise.reject(
        new Error(model === "sale.order" ? "Unknown model: sale.order" : "Invalid field 'x'")
      )
    );

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/^Could not read any Odoo model: /);
    expect(result.error).toContain("Unknown model: sale.order");
    expect(result.error).toContain("Invalid field 'x'");
    expect(result.error).not.toMatch(/read access/);
    expect(result.isAuthError).toBe(false);
  });

  it("says Odoo could not be reached when every probe failed to reach it, whatever each one said", async () => {
    vi.useFakeTimers();
    mockFields.mockImplementation((model: string) =>
      Promise.reject(
        model === "sale.order"
          ? Object.assign(new Error("fetch failed"), { code: 0 })
          : new Error("ETIMEDOUT")
      )
    );

    const promise = fetchOdooSchema(creds);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/^Could not reach Odoo: /);
    expect(result.error).toContain("fetch failed");
    expect(result.error).toContain("ETIMEDOUT");
    expect(result.isAuthError).toBe(false);
  });

  it("counts Odoo's own error as an answer even though it carries a JSON-RPC code", async () => {
    vi.useFakeTimers();
    // Odoo's server errors carry code 200 and `data`; it did answer.
    mockFields.mockRejectedValue(
      Object.assign(new Error("Lock wait timeout exceeded"), {
        code: 200,
        data: { name: "psycopg2.errors.LockNotAvailable" },
      })
    );

    const promise = fetchOdooSchema(creds);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Odoo did not answer successfully: Lock wait timeout exceeded");
  });

  // "Not Allowed" in an HTTP status line is the server refusing the method,
  // not Odoo refusing this user access to a model.
  it("does not read an HTTP 405 as an access denial", async () => {
    mockFields.mockRejectedValue(
      Object.assign(new Error("HTTP 405: Method Not Allowed"), { code: 405 })
    );

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("HTTP 405: Method Not Allowed");
    expect(result.isAuthError).toBe(false);
  });

  it("says Odoo could not be reached when odoo-node's answer broke off", async () => {
    // odoo-node wraps a failed body read as code 0, no data: no usable answer.
    mockFields.mockRejectedValue(Object.assign(new Error("terminated"), { code: 0 }));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Could not reach Odoo: terminated");
    expect(result.isAuthError).toBe(false);
  });

  it("keeps the read-access message when Odoo grants read access to no model", async () => {
    mockFields.mockResolvedValue([{ name: "id" }]);
    mockCheckAccessRights.mockResolvedValue(false);

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe(READ_ACCESS_MESSAGE);
    expect(result.isAuthError).toBe(false);
  });

  it("keeps the read-access message, as an auth error, when one model is denied and the rest fail alike", async () => {
    mockFields.mockImplementation((model: string) =>
      Promise.reject(new Error(model === "sale.order" ? "AccessError" : "Invalid field 'x'"))
    );

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe(READ_ACCESS_MESSAGE);
    expect(result.isAuthError).toBe(true);
  });

  it("reports one failure every model shares, without flagging an auth error", async () => {
    mockFields.mockRejectedValue(new Error("Invalid field 'x'"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Invalid field 'x'");
    expect(result.isAuthError).toBe(false);
  });

  it("returns isAuthError: true when all models fail due to auth/permission errors", async () => {
    mockFields.mockRejectedValue(new Error("access denied"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.isAuthError).toBe(true);
  });

  it("retries transient errors instead of treating them as no-access", async () => {
    let saleOrderCalls = 0;
    mockFields.mockImplementation((model: string) => {
      if (model !== "sale.order") {
        return Promise.reject(new Error("AccessError"));
      }

      saleOrderCalls++;
      if (saleOrderCalls === 1) {
        return Promise.reject(new Error("ETIMEDOUT"));
      }
      return Promise.resolve([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(saleOrderCalls).toBe(2);
    expect(result.models).toBeGreaterThan(0);
  });

  it("limits concurrency to avoid overwhelming the Odoo server", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    mockFields.mockImplementation(() => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      return new Promise((resolve) => {
        setTimeout(() => {
          concurrentCalls--;
          resolve([{ name: "id", string: "ID", type: "integer", required: true, readonly: true }]);
        }, 10);
      });
    });

    await fetchOdooSchema(creds);

    // Should not fire all model probes at once.
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("retries errors containing 'access' that are not Odoo access errors", async () => {
    let saleOrderCalls = 0;
    mockFields.mockImplementation((model: string) => {
      if (model !== "sale.order") {
        return Promise.reject(new Error("AccessError"));
      }

      saleOrderCalls++;
      if (saleOrderCalls === 1) {
        return Promise.reject(new Error("Failed to access host"));
      }
      return Promise.resolve([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(saleOrderCalls).toBe(2);
    expect(result.models).toBeGreaterThan(0);
  });

  it("does not retry missing-model errors", async () => {
    let saleOrderCalls = 0;
    mockFields.mockImplementation((model: string) => {
      if (model === "sale.order") {
        saleOrderCalls++;
        return Promise.reject(new Error("Unknown model: sale.order"));
      }
      return Promise.reject(new Error("AccessError"));
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    expect(saleOrderCalls).toBe(1);
    if (result.success) return;
    expect(result.error).toBe(READ_ACCESS_MESSAGE);
    expect(result.isAuthError).toBe(true);
  });

  it("does not retry 'access denied' errors", async () => {
    mockFields.mockRejectedValue(new Error("access denied"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
  });

  it("does not retry 'not allowed' errors", async () => {
    mockFields.mockRejectedValue(new Error("You are not allowed to access this document"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
  });

  it("does not retry 'permission denied' errors", async () => {
    mockFields.mockRejectedValue(new Error("permission denied for table sale_order"));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
  });

  it("distinguishes access errors from transient errors", async () => {
    mockFields.mockImplementation(() => {
      // AccessError is a real permission issue — should not retry
      return Promise.reject(new Error("AccessError: You do not have access to this resource"));
    });

    const result = await fetchOdooSchema(creds);

    // All models should be inaccessible (not retried endlessly)
    expect(result.success).toBe(false);
  });

  it("returns lastSyncAt timestamp", async () => {
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer", required: true, readonly: true },
    ]);

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.lastSyncAt).toBeTruthy();
    expect(new Date(result.lastSyncAt).getTime()).not.toBeNaN();
  });

  describe("access rights", () => {
    it("includes access rights in sync result", async () => {
      mockFields.mockResolvedValue([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.models.length).toBeGreaterThan(0);
      for (const model of result.data.models) {
        expect(model.access).toEqual({
          read: true,
          create: true,
          write: true,
          delete: true,
        });
      }
    });

    it("excludes models without read access", async () => {
      mockFields.mockResolvedValue([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
      // All ops return true except read returns false
      mockCheckAccessRights.mockImplementation((_model: string, op: string) => {
        return Promise.resolve(op !== "read");
      });

      const result = await fetchOdooSchema(creds);

      // No models should be accessible since read=false for all
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("Could not access any Odoo models");
    });

    it("maps unlink to delete in access object", async () => {
      mockFields.mockResolvedValue([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
      // read=true, create=true, write=true, unlink=true
      mockCheckAccessRights.mockResolvedValue(true);

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;

      const model = result.data.models[0];
      expect(model.access).toHaveProperty("delete");
      expect(model.access).not.toHaveProperty("unlink");
    });

    it("handles mixed access rights per model", async () => {
      // Only first model succeeds with fields
      let fieldsCallCount = 0;
      mockFields.mockImplementation(() => {
        fieldsCallCount++;
        if (fieldsCallCount === 1) {
          return Promise.resolve([
            { name: "id", string: "ID", type: "integer", required: true, readonly: true },
          ]);
        }
        return Promise.reject(new Error("AccessError"));
      });

      // read=true, create=false, write=true, unlink=false
      mockCheckAccessRights.mockImplementation((_model: string, op: string) => {
        if (op === "read" || op === "write") return Promise.resolve(true);
        return Promise.resolve(false);
      });

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.models.length).toBe(1);
      expect(result.data.models[0].access).toEqual({
        read: true,
        create: false,
        write: true,
        delete: false,
      });
    });

    it("handles checkAccessRights failure gracefully", async () => {
      mockFields.mockResolvedValue([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
      // checkAccessRights throws for all operations
      mockCheckAccessRights.mockRejectedValue(new Error("Network error"));

      const result = await fetchOdooSchema(creds);

      // All models should be excluded since read check fails (treated as false)
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("Could not access any Odoo models");
    });
  });

  describe("category summary", () => {
    it("returns categories with accessible status", async () => {
      // Only first call succeeds (sale.order = "Sales" category)
      let callCount = 0;
      mockFields.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          // First 3 calls are sale.order, sale.order.line, sale.order.template
          return Promise.resolve([
            { name: "name", string: "Name", type: "char", required: true, readonly: false },
          ]);
        }
        return Promise.reject(new Error("AccessError"));
      });

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.categories).toBeDefined();
      expect(result.categories.length).toBeGreaterThan(0);

      const sales = result.categories.find((c) => c.id === "sales");
      expect(sales).toBeDefined();
      expect(sales!.accessible).toBe(true);
      expect(sales!.accessibleModels.length).toBeGreaterThan(0);

      // Categories with no access should be marked as not accessible
      const inaccessible = result.categories.filter((c) => !c.accessible);
      expect(inaccessible.length).toBeGreaterThan(0);
    });

    it("includes category label and model names in sync result", async () => {
      mockFields.mockResolvedValue([
        { name: "name", string: "Name", type: "char", required: true, readonly: false },
      ]);

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;

      const sales = result.categories.find((c) => c.id === "sales");
      expect(sales!.label).toBe("Sales");
      expect(sales!.accessibleModels).toContain("Orders");
    });
  });
});

describe("getAccessibleCategoryLabels", () => {
  it("returns labels for categories that have matching models", () => {
    const data = {
      models: [
        { model: "sale.order", name: "Orders", fields: [] },
        { model: "res.partner", name: "Contacts", fields: [] },
      ],
      lastSyncAt: "2026-03-31T10:00:00Z",
    };

    const labels = getAccessibleCategoryLabels(data);
    expect(labels).toContain("Sales");
    expect(labels).toContain("Contacts");
    expect(labels).not.toContain("CRM");
    expect(labels).not.toContain("HR");
  });

  it("returns empty array for null data", () => {
    expect(getAccessibleCategoryLabels(null)).toEqual([]);
  });

  it("returns empty array for data without models", () => {
    expect(getAccessibleCategoryLabels({ lastSyncAt: "2026-03-31T10:00:00Z" } as never)).toEqual(
      []
    );
  });

  it("returns empty array when no models match any category", () => {
    const data = {
      models: [{ model: "unknown.model", name: "Unknown", fields: [] }],
      lastSyncAt: "2026-03-31T10:00:00Z",
    };
    expect(getAccessibleCategoryLabels(data)).toEqual([]);
  });
});
