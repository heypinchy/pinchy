import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFields = vi.fn();

vi.mock("odoo-node", () => {
  return {
    OdooClient: class {
      fields = mockFields;
    },
  };
});

import { fetchOdooSchema } from "../odoo-sync";

const creds = { url: "https://odoo.example.com", db: "test", uid: 2, apiKey: "key" };

describe("fetchOdooSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("includes category label and model names", async () => {
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
