import { describe, it, expect, vi } from "vitest";
import { evaluateGate, type FetchLike } from "./gate";

const cfg = { apiBaseUrl: "http://pinchy:7777", gatewayToken: "tok" };
const ctx = { sessionKey: "agent:a1:direct:u1" };

function fetchReturning(decision: string, reason?: string): FetchLike {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision, reason }) });
}

describe("evaluateGate", () => {
  it("allows when the route returns allow", async () => {
    expect(await evaluateGate("odoo_write", {}, ctx, cfg, fetchReturning("allow"))).toEqual({});
  });

  it("blocks with the route's reason", async () => {
    const res = await evaluateGate("odoo_write", {}, ctx, cfg, fetchReturning("block", "Approve to proceed"));
    expect(res).toEqual({ block: true, blockReason: "Approve to proceed" });
  });

  it("fails closed when the approval service is unreachable", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as FetchLike;
    const res = await evaluateGate("odoo_write", {}, ctx, cfg, f);
    expect(res.block).toBe(true);
    expect(res.blockReason).toMatch(/unavailable/i);
  });

  it("fails closed on a non-2xx response", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as FetchLike;
    expect((await evaluateGate("odoo_write", {}, ctx, cfg, f)).block).toBe(true);
  });

  it("sends the derived agentId, tool name, and params", async () => {
    const f = fetchReturning("allow");
    await evaluateGate("odoo_write", { recordId: 7 }, ctx, cfg, f);
    const body = JSON.parse((f as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toMatchObject({ agentId: "a1", toolName: "odoo_write", params: { recordId: 7 } });
  });

  it("does not gate (and does not call the API) without an identifiable agent/session", async () => {
    const f = fetchReturning("block");
    expect(await evaluateGate("odoo_write", {}, {}, cfg, f)).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
});
