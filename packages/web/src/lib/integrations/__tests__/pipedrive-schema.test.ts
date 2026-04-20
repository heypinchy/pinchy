import { describe, it, expect } from "vitest";
import {
  pipedriveCredentialsSchema,
  pipedriveConnectionDataSchema,
  maskPipedriveCredentials,
} from "../pipedrive-schema";

describe("pipedriveCredentialsSchema", () => {
  const validCredentials = {
    apiToken: "abc123token",
    companyDomain: "mycompany",
    companyName: "My Company Ltd",
    userId: 1,
    userName: "Jane Doe",
  };

  it("validates valid credentials", () => {
    const result = pipedriveCredentialsSchema.safeParse(validCredentials);
    expect(result.success).toBe(true);
  });

  it("rejects missing apiToken", () => {
    const { apiToken: _, ...rest } = validCredentials;
    const result = pipedriveCredentialsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty apiToken", () => {
    const result = pipedriveCredentialsSchema.safeParse({
      ...validCredentials,
      apiToken: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing companyDomain", () => {
    const { companyDomain: _, ...rest } = validCredentials;
    const result = pipedriveCredentialsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects userId of 0", () => {
    const result = pipedriveCredentialsSchema.safeParse({
      ...validCredentials,
      userId: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative userId", () => {
    const result = pipedriveCredentialsSchema.safeParse({
      ...validCredentials,
      userId: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer userId", () => {
    const result = pipedriveCredentialsSchema.safeParse({
      ...validCredentials,
      userId: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("pipedriveConnectionDataSchema", () => {
  it("validates schema with entities", () => {
    const result = pipedriveConnectionDataSchema.safeParse({
      entities: [
        {
          entity: "deals",
          name: "Deals",
          category: "CRM",
          fields: [
            {
              key: "title",
              name: "Title",
              type: "varchar",
              required: true,
            },
          ],
          operations: {
            read: true,
            create: true,
            update: true,
            delete: false,
          },
        },
      ],
      lastSyncAt: "2026-04-13T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("validates entity with optional fields array omitted", () => {
    const result = pipedriveConnectionDataSchema.safeParse({
      entities: [
        {
          entity: "notes",
          name: "Notes",
          category: "CRM",
          operations: {
            read: true,
            create: true,
            update: true,
            delete: true,
          },
        },
      ],
      lastSyncAt: "2026-04-13T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("validates field with options", () => {
    const result = pipedriveConnectionDataSchema.safeParse({
      entities: [
        {
          entity: "deals",
          name: "Deals",
          category: "CRM",
          fields: [
            {
              key: "stage_id",
              name: "Stage",
              type: "enum",
              required: false,
              options: [
                { id: 1, label: "Qualified" },
                { id: 2, label: "Proposal" },
              ],
            },
          ],
          operations: {
            read: true,
            create: true,
            update: true,
            delete: false,
          },
        },
      ],
      lastSyncAt: "2026-04-13T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing lastSyncAt", () => {
    const result = pipedriveConnectionDataSchema.safeParse({
      entities: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid lastSyncAt format", () => {
    const result = pipedriveConnectionDataSchema.safeParse({
      entities: [],
      lastSyncAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("maskPipedriveCredentials", () => {
  it("returns only non-sensitive fields", () => {
    const credentials = {
      apiToken: "secret-token-123",
      companyDomain: "mycompany",
      companyName: "My Company Ltd",
      userId: 1,
      userName: "Jane Doe",
    };
    const encrypted = JSON.stringify(credentials);
    const decrypt = (ciphertext: string) => ciphertext; // identity for test

    const masked = maskPipedriveCredentials(encrypted, decrypt);

    expect(masked).toEqual({
      companyDomain: "mycompany",
      companyName: "My Company Ltd",
      userName: "Jane Doe",
    });
    expect(masked).not.toHaveProperty("apiToken");
    expect(masked).not.toHaveProperty("userId");
  });
});
