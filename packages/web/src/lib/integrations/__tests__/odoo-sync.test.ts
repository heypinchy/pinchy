import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFields = vi.fn();
const mockCheckAccessRights = vi.fn();
const clientConfigs: unknown[] = [];

vi.mock("odoo-node", () => {
  return {
    OdooClient: class {
      fields = mockFields;
      checkAccessRights = mockCheckAccessRights;
      constructor(config: unknown) {
        clientConfigs.push(config);
      }
    },
  };
});

import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";
import { fetchOdooSchema, getAccessibleCategoryLabels, MODEL_CATEGORIES } from "../odoo-sync";

// Stands in for the pinned fetch a route gets from `withPinnedOdoo`.
const pinnedFetch = vi.fn() as unknown as typeof fetch;
const creds = {
  url: "https://odoo.example.com",
  db: "test",
  uid: 2,
  apiKey: "key",
  fetch: pinnedFetch,
};

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
    clientConfigs.length = 0;
    mockCheckAccessRights.mockResolvedValue(true);
  });

  it("sends every call through the fetch it is given", async () => {
    // The caller checked the URL and pinned this fetch to the answer; a client
    // without it would fetch by host name and resolve it a second time.
    mockFields.mockResolvedValue([]);

    await fetchOdooSchema(creds);

    expect(clientConfigs).toEqual([expect.objectContaining({ fetch: pinnedFetch })]);
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
    expect(result.error).toBe(
      "The Odoo address answered with an error: HTTP 405: Method Not Allowed"
    );
    expect(result.isAuthError).toBe(false);
  });

  // A WAF or proxy in front of Odoo answering every call with a status line:
  // not retried, but it needs the same context as a transient one.
  it("gives a shared non-transient status line the same context", async () => {
    mockFields.mockRejectedValue(Object.assign(new Error("HTTP 403: Forbidden"), { code: 403 }));

    const result = await fetchOdooSchema(creds);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("The Odoo address answered with an error: HTTP 403: Forbidden");
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

  it("does not prefix an answer that already says what came back", async () => {
    vi.useFakeTimers();
    mockFields.mockRejectedValue(
      Object.assign(new Error("Response is not JSON-RPC (HTTP 500, text/html)"), { code: 500 })
    );

    const promise = fetchOdooSchema(creds);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe(
      "Odoo answered with something that is not a JSON-RPC response (HTTP 500, text/html). " +
        "Check that the URL points at the Odoo server itself."
    );
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

  describe("when Odoo stops answering", () => {
    // odoo-node's error for a request the pinned fetch's bound cut off.
    const timedOut = () =>
      Object.assign(new Error("The operation was aborted due to timeout"), {
        code: 0,
        cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      });

    it("neither retries a timed-out probe nor starts any more, and says Odoo did not answer in time", async () => {
      // Each probe of a blackhole costs the whole bound. Retrying it, and
      // walking every curated model five at a time, turned one silent server
      // into an hour-long sync.
      mockFields.mockRejectedValue(timedOut());

      const result = await fetchOdooSchema(creds);

      expect(mockFields.mock.calls.length).toBeLessThanOrEqual(5);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.isAuthError).toBe(false);
      expect(result.error).toMatch(
        /^Could not reach Odoo: Odoo did not answer within \d+ seconds\./
      );
    });

    it("fails the sync rather than save the models that answered before it stopped", async () => {
      // A partial schema would quietly drop every model that was never probed.
      let calls = 0;
      mockFields.mockImplementation(() => {
        calls++;
        return calls <= 3
          ? Promise.resolve([{ name: "id", string: "ID", type: "integer" }])
          : Promise.reject(timedOut());
      });

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.isAuthError).toBe(false);
      expect(result.error).toMatch(
        /^Odoo stopped answering partway through reading its models: Odoo did not answer within \d+ seconds\./
      );
    });

    it("does not say Odoo stopped partway when the models it skipped were never read", async () => {
      // A fast proxy error stops new probes; a probe still running then times out.
      vi.useFakeTimers();
      mockFields.mockImplementation((model: string) => {
        if (model === "sale.order") {
          return Promise.reject(Object.assign(new Error("HTTP 502: Bad Gateway"), { code: 502 }));
        }
        return new Promise((_, reject) => setTimeout(() => reject(timedOut()), 5_000));
      });

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(
        /^Could not reach Odoo: Odoo did not answer within \d+ seconds\./
      );
    });

    it("does not read an access check that timed out as missing access", async () => {
      mockFields.mockResolvedValue([{ name: "id", string: "ID", type: "integer" }]);
      mockCheckAccessRights.mockRejectedValue(timedOut());

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.isAuthError).toBe(false);
      expect(result.error).toMatch(
        /^Could not reach Odoo: Odoo did not answer within \d+ seconds\./
      );
    });

    it("counts Odoo's own error about a model as an answer", async () => {
      // A model whose app is not installed: Odoo answered, so it stopped partway.
      // sale.order is the catalog's first model, so it is always probed.
      mockFields.mockImplementation((model: string) =>
        Promise.reject(
          model === "sale.order"
            ? Object.assign(new Error("Object sale.order doesn't exist"), {
                code: 200,
                data: { name: "builtins.KeyError" },
              })
            : timedOut()
        )
      );

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(
        /^Odoo stopped answering partway through reading its models: Odoo did not answer within \d+ seconds\./
      );
    });

    it("does not restart a probe that was waiting to retry when another timed out", async () => {
      // Retrying it would cost the whole bound again on an Odoo gone silent.
      vi.useFakeTimers();
      mockFields.mockImplementation((model: string) =>
        model === "sale.order"
          ? Promise.reject(new Error("ECONNRESET"))
          : new Promise((_, reject) => setTimeout(() => reject(timedOut()), 100))
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      const saleOrderCalls = mockFields.mock.calls.filter(([model]) => model === "sale.order");
      expect(saleOrderCalls).toHaveLength(1);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(
        /^Could not reach Odoo: Odoo did not answer within \d+ seconds\./
      );
    });
  });

  describe("when a probe gives up without an answer from Odoo", () => {
    const fieldsAfter = (ms: number) =>
      new Promise((resolve) => setTimeout(() => resolve([{ name: "id", type: "integer" }]), ms));

    // A proxy in front of Odoo cutting requests off with its own 502 or 504
    // fails every model alike; a single probe that ran out of retries on one
    // is not a model to skip.
    it("fails the sync instead of saving the schema without that model", async () => {
      vi.useFakeTimers();
      mockFields.mockImplementation((model: string) =>
        model === "sale.order"
          ? Promise.reject(Object.assign(new Error("HTTP 504: Gateway Timeout"), { code: 504 }))
          : fieldsAfter(10)
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.isAuthError).toBe(false);
      expect(result.error).toBe(
        "Reading Odoo's models failed partway through, so nothing was saved: " +
          "The Odoo address answered with an error: HTTP 504: Gateway Timeout"
      );
    });

    it("names the connection failure, not the models Odoo says it does not have", async () => {
      // Most installs lack a few curated apps; their errors come first in the
      // catalog and must not stand in for the proxy error that stopped the sync.
      vi.useFakeTimers();
      const missing = new Set(["sale.subscription.plan", "purchase.order", "purchase.order.line"]);
      mockFields.mockImplementation((model: string) => {
        if (missing.has(model)) {
          return Promise.reject(
            Object.assign(new Error(`Object ${model} doesn't exist`), {
              code: 200,
              data: { name: "builtins.KeyError" },
            })
          );
        }
        if (model === "stock.picking") {
          return Promise.reject(
            Object.assign(new Error("HTTP 504: Gateway Timeout"), { code: 504 })
          );
        }
        return fieldsAfter(10);
      });

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(
        "Reading Odoo's models failed partway through, so nothing was saved: " +
          "The Odoo address answered with an error: HTTP 504: Gateway Timeout"
      );
    });

    it("says it failed partway when Odoo answered some model, even if none was readable", async () => {
      // Odoo's own error about a model it lacks is an answer: the 504 came
      // partway through, not before Odoo said anything.
      vi.useFakeTimers();
      mockFields.mockImplementation((model: string) =>
        model === "stock.picking"
          ? Promise.reject(Object.assign(new Error("HTTP 504: Gateway Timeout"), { code: 504 }))
          : Promise.reject(
              Object.assign(new Error(`Object ${model} doesn't exist`), {
                code: 200,
                data: { name: "builtins.KeyError" },
              })
            )
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(
        "Reading Odoo's models failed partway through, so nothing was saved: " +
          "The Odoo address answered with an error: HTTP 504: Gateway Timeout"
      );
    });

    it("does not say it failed partway when no model got an answer from Odoo", async () => {
      vi.useFakeTimers();
      mockFields.mockRejectedValue(
        Object.assign(new Error("HTTP 504: Gateway Timeout"), { code: 504 })
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(
        "The Odoo address answered with an error: HTTP 504: Gateway Timeout"
      );
    });

    it("starts no further probe once one gave up", async () => {
      // Under a proxy that times out before our bound, each probe costs that
      // proxy's timeout three times over: walking all models took most of an hour.
      vi.useFakeTimers();
      mockFields.mockImplementation((model: string) =>
        model === "sale.order"
          ? Promise.reject(Object.assign(new Error("HTTP 504: Gateway Timeout"), { code: 504 }))
          : fieldsAfter(5_000)
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      await promise;

      vi.useRealTimers();
      const probedModels = new Set(mockFields.mock.calls.map(([model]) => model));
      expect(probedModels.size).toBeLessThanOrEqual(5);
    });

    it("fails the sync when an access check is cut off by a proxy error", async () => {
      vi.useFakeTimers();
      mockFields.mockResolvedValue([{ name: "id", string: "ID", type: "integer" }]);
      mockCheckAccessRights.mockImplementation((model: string) =>
        model === "sale.order"
          ? Promise.reject(Object.assign(new Error("HTTP 502: Bad Gateway"), { code: 502 }))
          : Promise.resolve(true)
      );

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("HTTP 502: Bad Gateway");
      expect(result.isAuthError).toBe(false);
    });

    it("still skips a model Odoo itself says it does not have", async () => {
      // A module that is not installed: Odoo answers, with its own error.
      mockFields.mockImplementation((model: string) =>
        model === "sale.subscription.plan"
          ? Promise.reject(
              Object.assign(new Error("sale.subscription.plan"), {
                code: 200,
                data: { name: "builtins.KeyError" },
              })
            )
          : Promise.resolve([{ name: "id", string: "ID", type: "integer" }])
      );

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.models.map((m) => m.model)).not.toContain("sale.subscription.plan");
      expect(result.data.models.map((m) => m.model)).toContain("sale.order");
    });
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

    it("reads an access check that got no answer as Odoo unreachable, not as missing access", async () => {
      vi.useFakeTimers();
      mockFields.mockResolvedValue([
        { name: "id", string: "ID", type: "integer", required: true, readonly: true },
      ]);
      mockCheckAccessRights.mockRejectedValue(new Error("Network error"));

      const promise = fetchOdooSchema(creds);
      await vi.runAllTimersAsync();
      const result = await promise;

      vi.useRealTimers();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe("Could not reach Odoo: Network error");
      expect(result.isAuthError).toBe(false);
    });

    it("reads Odoo's own error on an access check as no access", async () => {
      mockFields.mockResolvedValue([{ name: "id", string: "ID", type: "integer" }]);
      mockCheckAccessRights.mockRejectedValue(
        Object.assign(new Error("Access Denied"), {
          code: 200,
          data: { name: "odoo.exceptions.AccessError" },
        })
      );

      const result = await fetchOdooSchema(creds);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(READ_ACCESS_MESSAGE);
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
