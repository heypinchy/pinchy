import { describe, it, expect } from "vitest";
import { odooConnectionDataSchema, odooCredentialsSchema } from "../odoo-schema";

describe("odooCredentialsSchema", () => {
  it("validates valid credentials", () => {
    const result = odooCredentialsSchema.safeParse({
      url: "https://odoo.example.com",
      db: "production",
      login: "admin",
      apiKey: "abc123",
      uid: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing url", () => {
    const result = odooCredentialsSchema.safeParse({
      db: "prod",
      login: "admin",
      apiKey: "x",
      uid: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid url", () => {
    const result = odooCredentialsSchema.safeParse({
      url: "not-a-url",
      db: "prod",
      login: "admin",
      apiKey: "x",
      uid: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects uid of 0", () => {
    const result = odooCredentialsSchema.safeParse({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
      apiKey: "x",
      uid: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("odooConnectionDataSchema", () => {
  it("validates schema with models", () => {
    const result = odooConnectionDataSchema.safeParse({
      models: [
        {
          model: "sale.order",
          name: "Sales Order",
          fields: [
            {
              name: "name",
              string: "Order Reference",
              type: "char",
              required: true,
              readonly: true,
            },
          ],
        },
      ],
      lastSyncAt: "2026-03-26T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("validates model with optional field properties", () => {
    const result = odooConnectionDataSchema.safeParse({
      models: [
        {
          model: "sale.order",
          name: "Sales Order",
          fields: [
            {
              name: "partner_id",
              string: "Customer",
              type: "many2one",
              required: false,
              readonly: false,
              relation: "res.partner",
            },
            {
              name: "state",
              string: "Status",
              type: "selection",
              required: true,
              readonly: true,
              selection: [
                ["draft", "Quotation"],
                ["sale", "Sales Order"],
              ],
            },
          ],
        },
      ],
      lastSyncAt: "2026-03-26T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing lastSyncAt", () => {
    const result = odooConnectionDataSchema.safeParse({
      models: [],
    });
    expect(result.success).toBe(false);
  });
});
