import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We mock global fetch — no real HTTP calls
const mockFetch = vi.fn();

import {
  fetchPipedriveSchema,
  getAccessibleCategoryLabels,
  ENTITY_CATEGORIES,
} from "../pipedrive-sync";

/** Helper: build a successful Pipedrive list response (probe). */
function probeOk() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data: [{ id: 1 }] }),
  };
}

/** Helper: build a 403 plan-restricted response. */
function probe403() {
  return {
    ok: false,
    status: 403,
    json: () =>
      Promise.resolve({
        success: false,
        error: "Forbidden",
        error_info: "Your plan does not include this feature",
      }),
  };
}

/** Helper: build a fields response. */
function fieldsResponse(
  fields: Array<{
    key: string;
    name: string;
    field_type: string;
    mandatory_flag?: boolean;
    options?: Array<{ id: number; label: string }>;
  }>
) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data: fields }),
  };
}

const ALL_ENTITIES = ENTITY_CATEGORIES.flatMap((cat) => cat.entities);

describe("fetchPipedriveSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes all known entities, skips 403s", async () => {
    // Make deals accessible, everything else 403
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/deals?") || urlStr.includes("/v1/deals?")) {
        return Promise.resolve(probeOk());
      }
      if (urlStr.includes("/v1/dealFields")) {
        return Promise.resolve(
          fieldsResponse([
            { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true },
          ])
        );
      }
      return Promise.resolve(probe403());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Only deals should be accessible
    expect(result.entities).toBe(1);
    expect(result.data.entities).toHaveLength(1);
    expect(result.data.entities[0].entity).toBe("deals");

    // Should have probed ALL entities (one fetch per entity)
    const probeCalls = mockFetch.mock.calls.filter(
      (call) => call[0].toString().includes("limit=1") && !call[0].toString().includes("Fields")
    );
    expect(probeCalls.length).toBe(ALL_ENTITIES.length);
  });

  it("fetches fields for entities with fieldsEndpoint", async () => {
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();

      // All probes succeed
      if (urlStr.includes("limit=1")) {
        return Promise.resolve(probeOk());
      }

      // Fields endpoints return field data
      if (urlStr.includes("/v1/dealFields")) {
        return Promise.resolve(
          fieldsResponse([
            { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true },
            { key: "value", name: "Value", field_type: "monetary", mandatory_flag: false },
          ])
        );
      }
      if (urlStr.includes("/v1/personFields")) {
        return Promise.resolve(
          fieldsResponse([
            { key: "name", name: "Name", field_type: "varchar", mandatory_flag: true },
          ])
        );
      }
      // Other fields endpoints return empty
      if (urlStr.includes("Fields")) {
        return Promise.resolve(fieldsResponse([]));
      }

      return Promise.resolve(probeOk());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    const deals = result.data.entities.find((e) => e.entity === "deals");
    expect(deals).toBeDefined();
    expect(deals!.fields).toHaveLength(2);
    expect(deals!.fields![0]).toEqual({
      key: "title",
      name: "Title",
      type: "varchar",
      required: true,
      options: undefined,
    });

    const persons = result.data.entities.find((e) => e.entity === "persons");
    expect(persons).toBeDefined();
    expect(persons!.fields).toHaveLength(1);

    // Entities without fieldsEndpoint should have no fields
    const pipelines = result.data.entities.find((e) => e.entity === "pipelines");
    expect(pipelines).toBeDefined();
    expect(pipelines!.fields).toBeUndefined();
  });

  it("returns categorized results with entity count", async () => {
    // All probes succeed, no fields
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("limit=1")) {
        return Promise.resolve(probeOk());
      }
      if (urlStr.includes("Fields")) {
        return Promise.resolve(fieldsResponse([]));
      }
      return Promise.resolve(probeOk());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.entities).toBe(ALL_ENTITIES.length);
    expect(result.categories.length).toBeGreaterThan(0);

    const crm = result.categories.find((c) => c.id === "crm");
    expect(crm).toBeDefined();
    expect(crm!.label).toBe("CRM");
    expect(crm!.accessible).toBe(true);
    expect(crm!.accessibleModels.length).toBe(5); // deals, persons, orgs, leads, activities
  });

  it("returns error if no entities are accessible", async () => {
    // Everything returns 403
    mockFetch.mockResolvedValue(probe403());

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Could not access any Pipedrive entities");
  });

  it("retries transient errors (network errors) but not 403s", async () => {
    const callsByUrl = new Map<string, number>();

    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      const count = (callsByUrl.get(urlStr) ?? 0) + 1;
      callsByUrl.set(urlStr, count);

      // 403 for all except deals
      if (urlStr.includes("/v1/deals?")) {
        // First call fails with network error, second succeeds
        if (count === 1) {
          return Promise.reject(new Error("fetch failed"));
        }
        return Promise.resolve(probeOk());
      }
      if (urlStr.includes("/v1/dealFields")) {
        return Promise.resolve(
          fieldsResponse([
            { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true },
          ])
        );
      }
      return Promise.resolve(probe403());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Deals should be accessible (retried successfully)
    expect(result.data.entities.find((e) => e.entity === "deals")).toBeDefined();

    // Verify deals probe was called twice (initial + 1 retry)
    const dealsUrl = Array.from(callsByUrl.keys()).find((k) => k.includes("/v1/deals?"));
    expect(callsByUrl.get(dealsUrl!)).toBe(2);

    // Verify 403 entities were NOT retried
    const personsUrl = Array.from(callsByUrl.keys()).find((k) => k.includes("/v1/persons?"));
    expect(callsByUrl.get(personsUrl!)).toBe(1);
  });

  it("limits concurrency", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    mockFetch.mockImplementation((url: string) => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      return new Promise((resolve) => {
        setTimeout(() => {
          concurrentCalls--;
          const urlStr = url.toString();
          if (urlStr.includes("Fields")) {
            resolve(fieldsResponse([]));
          } else {
            resolve(probeOk());
          }
        }, 10);
      });
    });

    await fetchPipedriveSchema("test-api-token");

    // Should not fire all requests at once
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("maps fields correctly (field_type → type, mandatory_flag → required, options)", async () => {
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("limit=1")) {
        return Promise.resolve(probeOk());
      }
      if (urlStr.includes("/v1/dealFields")) {
        return Promise.resolve(
          fieldsResponse([
            { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true },
            { key: "value", name: "Value", field_type: "monetary" },
            {
              key: "status",
              name: "Status",
              field_type: "enum",
              mandatory_flag: false,
              options: [
                { id: 1, label: "Open" },
                { id: 2, label: "Won" },
              ],
            },
          ])
        );
      }
      if (urlStr.includes("Fields")) {
        return Promise.resolve(fieldsResponse([]));
      }
      return Promise.resolve(probeOk());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    const deals = result.data.entities.find((e) => e.entity === "deals");
    expect(deals).toBeDefined();
    expect(deals!.fields).toBeDefined();

    const titleField = deals!.fields!.find((f) => f.key === "title");
    expect(titleField).toEqual({
      key: "title",
      name: "Title",
      type: "varchar",
      required: true,
      options: undefined,
    });

    // mandatory_flag defaults to false when absent
    const valueField = deals!.fields!.find((f) => f.key === "value");
    expect(valueField!.required).toBe(false);

    // options mapped correctly
    const statusField = deals!.fields!.find((f) => f.key === "status");
    expect(statusField!.type).toBe("enum");
    expect(statusField!.options).toEqual([
      { id: 1, label: "Open" },
      { id: 2, label: "Won" },
    ]);
  });

  it("includes operations for each entity", async () => {
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("limit=1")) return Promise.resolve(probeOk());
      if (urlStr.includes("Fields")) return Promise.resolve(fieldsResponse([]));
      return Promise.resolve(probeOk());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const entity of result.data.entities) {
      expect(entity.operations).toBeDefined();
      expect(entity.operations).toHaveProperty("read");
      expect(entity.operations).toHaveProperty("create");
      expect(entity.operations).toHaveProperty("update");
      expect(entity.operations).toHaveProperty("delete");
    }

    // Files specifically should have update=false
    const files = result.data.entities.find((e) => e.entity === "files");
    expect(files).toBeDefined();
    expect(files!.operations.update).toBe(false);
  });

  it("returns lastSyncAt timestamp", async () => {
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("limit=1")) return Promise.resolve(probeOk());
      if (urlStr.includes("Fields")) return Promise.resolve(fieldsResponse([]));
      return Promise.resolve(probeOk());
    });

    const result = await fetchPipedriveSchema("test-api-token");

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.lastSyncAt).toBeTruthy();
    expect(new Date(result.lastSyncAt).getTime()).not.toBeNaN();
    expect(result.data.lastSyncAt).toBe(result.lastSyncAt);
  });

  it("sends api token in x-api-token header", async () => {
    mockFetch.mockImplementation((url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes("limit=1")) return Promise.resolve(probeOk());
      if (urlStr.includes("Fields")) return Promise.resolve(fieldsResponse([]));
      return Promise.resolve(probeOk());
    });

    await fetchPipedriveSchema("my-secret-token");

    // All fetch calls should have the x-api-token header
    for (const call of mockFetch.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.headers).toBeDefined();
      expect((options.headers as Record<string, string>)["x-api-token"]).toBe("my-secret-token");
    }
  });
});

describe("getAccessibleCategoryLabels", () => {
  it("returns labels for categories that have matching entities", () => {
    const data = {
      entities: [
        { entity: "deals", name: "Deals", category: "crm" },
        { entity: "products", name: "Products", category: "products" },
      ],
      lastSyncAt: "2026-04-13T10:00:00Z",
    };

    const labels = getAccessibleCategoryLabels(data);
    expect(labels).toContain("CRM");
    expect(labels).toContain("Products");
    expect(labels).not.toContain("Pipeline");
    expect(labels).not.toContain("Projects");
  });

  it("returns empty array for null data", () => {
    expect(getAccessibleCategoryLabels(null)).toEqual([]);
  });

  it("returns empty array for data without entities", () => {
    expect(getAccessibleCategoryLabels({ lastSyncAt: "2026-04-13T10:00:00Z" } as never)).toEqual(
      []
    );
  });

  it("returns empty array when no entities match any category", () => {
    const data = {
      entities: [{ entity: "unknown_thing" }],
      lastSyncAt: "2026-04-13T10:00:00Z",
    };
    expect(getAccessibleCategoryLabels(data)).toEqual([]);
  });
});
