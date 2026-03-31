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

    // Should have probed known models, not called client.models()
    expect(mockFields).toHaveBeenCalled();
    expect(result.models).toBeGreaterThan(0);
  });

  it("skips models the user has no access to", async () => {
    let callCount = 0;
    mockFields.mockImplementation(() => {
      callCount++;
      // First call succeeds, second throws AccessError
      if (callCount === 1) {
        return Promise.resolve([
          { name: "id", string: "ID", type: "integer", required: true, readonly: true },
        ]);
      }
      return Promise.reject(new Error("AccessError: no access to sale.order.line"));
    });

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should have at least 1 model (the one that succeeded)
    // and less than total probed (some were skipped)
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

  it("includes human-readable model names from curated list", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char", required: true, readonly: false },
    ]);

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const saleOrder = result.data.models.find((m) => m.model === "sale.order");
    expect(saleOrder).toBeDefined();
    expect(saleOrder!.name).toBe("Sales Order");
  });

  it("returns lastSyncAt timestamp", async () => {
    mockFields.mockResolvedValue([]);

    // Will fail because all models return empty fields → skipped
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer", required: true, readonly: true },
    ]);

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.lastSyncAt).toBeTruthy();
    expect(new Date(result.lastSyncAt).getTime()).not.toBeNaN();
  });
});
