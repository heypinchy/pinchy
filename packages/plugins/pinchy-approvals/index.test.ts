import { describe, it, expect, vi, afterEach } from "vitest";
import plugin from "./index";

type Handler = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; blockReason?: string }>;

function makeApi(pluginConfig?: unknown) {
  const handlers: Record<string, Handler> = {};
  const warn = vi.fn();
  const api = {
    pluginConfig,
    logger: { warn },
    on: (name: string, h: Handler) => {
      handlers[name] = h;
    },
  };
  return { api, handlers, warn };
}

const CONFIG = { apiBaseUrl: "http://pinchy:7777", gatewayToken: "t" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pinchy-approvals plugin", () => {
  it("warns and registers no hook without config", () => {
    const { api, handlers, warn } = makeApi(undefined);
    // @ts-expect-error minimal api shim
    plugin.register(api);
    expect(warn).toHaveBeenCalled();
    expect(handlers.before_tool_call).toBeUndefined();
  });

  it("registers a before_tool_call gate when configured", () => {
    const { api, handlers } = makeApi(CONFIG);
    // @ts-expect-error minimal api shim
    plugin.register(api);
    expect(typeof handlers.before_tool_call).toBe("function");
  });

  it("blocks the call when the gate-check route says block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ decision: "block", reason: "Confirm it" }),
      })
    );
    const { api, handlers } = makeApi(CONFIG);
    // @ts-expect-error minimal api shim
    plugin.register(api);
    const result = await handlers.before_tool_call(
      { toolName: "odoo_write", params: {} },
      { sessionKey: "agent:a:direct:u" }
    );
    expect(result).toEqual({ block: true, blockReason: "Confirm it" });
  });

  // #1132. The approval OpenClaw broadcasts carries the toolCallId of the call
  // it suspended, and that is the only field that identifies WHICH call it was:
  // a model can emit the same tool with the same arguments twice in one turn,
  // and (agent, session, tool, args) would then name both. Without it the row
  // and the broadcast cannot be matched, so the confirmation the user clicks
  // could resume a different call than the one they read.
  it("passes the toolCallId through so the row and the approval can be matched", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: "allow" }) });
    vi.stubGlobal("fetch", f);
    const { api, handlers } = makeApi(CONFIG);
    // @ts-expect-error minimal api shim
    plugin.register(api);

    await handlers.before_tool_call(
      { toolName: "odoo_write", params: {}, toolCallId: "call_42" },
      { sessionKey: "agent:a:direct:u" }
    );

    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ toolCallId: "call_42" });
  });

  // OpenClaw threads the id through BOTH the event and the hook context, and
  // which one is populated depends on the call path. Reading only one of them
  // yields undefined on the other, which silently degrades to an unmatchable
  // approval rather than to an error.
  it("falls back to the hook context when the event carries no toolCallId", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: "allow" }) });
    vi.stubGlobal("fetch", f);
    const { api, handlers } = makeApi(CONFIG);
    // @ts-expect-error minimal api shim
    plugin.register(api);

    await handlers.before_tool_call(
      { toolName: "odoo_write", params: {} },
      { sessionKey: "agent:a:direct:u", toolCallId: "call_from_ctx" }
    );

    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ toolCallId: "call_from_ctx" });
  });

  it("allows the call when the route says allow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: "allow" }) })
    );
    const { api, handlers } = makeApi(CONFIG);
    // @ts-expect-error minimal api shim
    plugin.register(api);
    const result = await handlers.before_tool_call(
      { toolName: "odoo_write", params: {} },
      { sessionKey: "agent:a:direct:u" }
    );
    expect(result).toEqual({});
  });
});
