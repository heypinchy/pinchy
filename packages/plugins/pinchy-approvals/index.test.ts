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
