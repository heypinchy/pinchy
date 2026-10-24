import { describe, expect, it, vi } from "vitest";
import {
  buildFidelityProbeBody,
  interpretFidelityProbe,
  assertOdooMockEnforcesMany2One,
  resolveOdooMockJsonRpcUrl,
  FIDELITY_PROBE_ACCOUNT_ID,
} from "../odoo-mock-fidelity";

// The mock's faithful rejection (config/odoo-mock/server.js validateMany2OneValues
// -> the /jsonrpc handler wraps it as a JSON-RPC error envelope, HTTP 200).
const REJECTED = {
  jsonrpc: "2.0",
  id: 1,
  error: {
    message: `Invalid value for many2one field account.move.line.account_id: expected id, got "${FIDELITY_PROBE_ACCOUNT_ID}"`,
    code: 200,
    data: { message: "Invalid value for many2one field account.move.line.account_id" },
  },
};

// A STALE mock (predating #615) has no many2one validation, so the create
// succeeds and returns the new record id.
const ACCEPTED = { jsonrpc: "2.0", id: 1, result: 42 };

describe("buildFidelityProbeBody", () => {
  it("creates an account.move.line with a non-resolvable STRING account_id", () => {
    const body = buildFidelityProbeBody() as {
      params: { method: string; args: unknown[] };
    };
    expect(body.params.method).toBe("execute_kw");
    const [, , , model, method, positional] = body.params.args as [
      string,
      unknown,
      string,
      string,
      string,
      Array<Record<string, unknown>>,
    ];
    expect(model).toBe("account.move.line");
    expect(method).toBe("create");
    // A string account_id is exactly what a faithful mock rejects and a stale
    // one credits — the whole discriminator. It must be a string, not a number.
    expect(typeof positional[0].account_id).toBe("string");
    expect(positional[0].account_id).toBe(FIDELITY_PROBE_ACCOUNT_ID);
  });
});

describe("resolveOdooMockJsonRpcUrl", () => {
  it("prefers MOCK_ODOO_JSONRPC_URL and falls back to the eval host port 8169", () => {
    expect(resolveOdooMockJsonRpcUrl({ MOCK_ODOO_JSONRPC_URL: "http://x:1/jsonrpc" })).toBe(
      "http://x:1/jsonrpc"
    );
    expect(resolveOdooMockJsonRpcUrl({})).toBe("http://localhost:8169/jsonrpc");
  });
});

describe("interpretFidelityProbe", () => {
  it("treats a JSON-RPC error envelope as faithful (mock rejected the bad m2o)", () => {
    expect(interpretFidelityProbe(REJECTED).faithful).toBe(true);
  });

  it("treats a successful create (result id) as STALE — the mock accepted the string", () => {
    const v = interpretFidelityProbe(ACCEPTED);
    expect(v.faithful).toBe(false);
    expect(v.reason).toMatch(/accepted/i);
  });

  it("fails closed on an unexpected shape (neither error nor a create id)", () => {
    expect(interpretFidelityProbe({ jsonrpc: "2.0", id: 1 }).faithful).toBe(false);
    expect(interpretFidelityProbe(null).faithful).toBe(false);
    expect(interpretFidelityProbe("nonsense").faithful).toBe(false);
  });
});

describe("assertOdooMockEnforcesMany2One", () => {
  const url = "http://localhost:8169/jsonrpc";

  it("resolves against a faithful mock", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REJECTED,
    }) as unknown as typeof fetch;
    await expect(assertOdooMockEnforcesMany2One(url, { fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws a stale-mock error (with remediation + #1165) when the mock ACCEPTS the string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ACCEPTED,
    }) as unknown as typeof fetch;
    await expect(assertOdooMockEnforcesMany2One(url, { fetchImpl })).rejects.toThrow(
      /stale|unfaithful/i
    );
    await expect(assertOdooMockEnforcesMany2One(url, { fetchImpl })).rejects.toThrow(/--build/);
    await expect(assertOdooMockEnforcesMany2One(url, { fetchImpl })).rejects.toThrow(/1165/);
  });

  it("throws (fail-closed) when the JSON-RPC endpoint is unreachable", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(assertOdooMockEnforcesMany2One(url, { fetchImpl })).rejects.toThrow(
      /could not reach|unreachable|ECONNREFUSED/i
    );
  });
});
