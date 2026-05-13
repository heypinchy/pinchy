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

import { fetchOdooSchema, getAccessibleCategoryLabels } from "../odoo-sync";

const creds = { url: "https://odoo.example.com", db: "test", uid: 2, apiKey: "key" };

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
  });

  // Each model fails once then retries after a 500ms backoff. With ~80 models
  // and 5-way concurrency, that's >8s of wall time — well above vitest's
  // default 5s. The retry behavior itself is what we're testing, so we let
  // the test take the real wait. Same applies to the sibling "retries errors
  // containing 'access'" test below.
  const RETRY_TEST_TIMEOUT_MS = 15_000;

  it(
    "retries transient errors instead of treating them as no-access",
    async () => {
      // Per-model retry tracking — the earlier global-callCount approach broke
      // once MODEL_CATEGORIES grew past ~40 models because the 5-way concurrency
      // makes call-ordering non-deterministic (you can't say "first call for
      // each model" with a single shared counter).
      const callCounts = new Map<string, number>();
      mockFields.mockImplementation((model: string) => {
        const count = (callCounts.get(model) ?? 0) + 1;
        callCounts.set(model, count);
        if (count === 1) {
          return Promise.reject(new Error("ETIMEDOUT"));
        }
        return Promise.resolve([
          { name: "id", string: "ID", type: "integer", required: true, readonly: true },
        ]);
      });

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Models should be accessible after retry
      expect(result.models).toBeGreaterThan(0);
    },
    RETRY_TEST_TIMEOUT_MS
  );

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

    // Should not fire all ~40 requests at once
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it(
    "retries errors containing 'access' that are not Odoo access errors",
    async () => {
      const callCounts = new Map<string, number>();
      mockFields.mockImplementation((model: string) => {
        const count = (callCounts.get(model) ?? 0) + 1;
        callCounts.set(model, count);
        if (count === 1) {
          return Promise.reject(new Error("Failed to access host"));
        }
        return Promise.resolve([
          { name: "id", string: "ID", type: "integer", required: true, readonly: true },
        ]);
      });

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.models).toBeGreaterThan(0);
    },
    RETRY_TEST_TIMEOUT_MS
  );

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
