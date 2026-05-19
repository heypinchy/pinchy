import { describe, it, expect, vi } from "vitest";

// odoo-node is mocked the same way as in tools.test.ts so the plugin can
// register without contacting a real Odoo instance.
vi.mock("odoo-node", () => {
  const MockOdooClient = vi.fn(function (this: Record<string, unknown>) {});
  return { OdooClient: MockOdooClient };
});

import plugin from "../index";

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const testPermissions = {
  "sale.order": ["read"],
};

const agentId = "agent-1";
const agentConfig = {
  connectionId: "conn-test-1",
  permissions: testPermissions,
  modelNames: {},
};

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({
    type: "odoo",
    credentials: {
      url: "https://example.com",
      db: "x",
      uid: 1,
      apiKey: "k",
    },
  }),
}));
globalThis.fetch = fetchMock as unknown as typeof fetch;

function collectAllTools(): AgentTool[] {
  const tools: AgentTool[] = [];
  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy-test:7777",
      gatewayToken: "test-gateway-token",
      agents: { [agentId]: agentConfig },
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
    ) => {
      const t = factory({ agentId });
      if (t) tools.push(t);
    },
  };
  plugin.register(api);
  return tools;
}

// Walks a JSON-schema-ish tree and yields every node that declares
// `type: "array"`. Descends into `properties`, `items`, and `oneOf|anyOf|allOf`
// so deeply nested arrays (e.g. arrays of arrays) are caught.
function* walkArraySchemas(
  node: unknown,
  path: string[] = [],
): Generator<{ node: Record<string, unknown>; path: string[] }> {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (obj.type === "array") {
    yield { node: obj, path };
  }

  if (obj.properties && typeof obj.properties === "object") {
    for (const [key, value] of Object.entries(
      obj.properties as Record<string, unknown>,
    )) {
      yield* walkArraySchemas(value, [...path, "properties", key]);
    }
  }
  if (obj.items !== undefined) {
    yield* walkArraySchemas(obj.items, [...path, "items"]);
  }
  for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
    const list = obj[combinator];
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        yield* walkArraySchemas(list[i], [...path, combinator, String(i)]);
      }
    }
  }
}

describe("OpenAI strict-schema compatibility", () => {
  it("every `type: array` in every tool's parameters declares `items`", () => {
    const tools = collectAllTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const tool of tools) {
      for (const { node, path } of walkArraySchemas(tool.parameters)) {
        if (!("items" in node)) {
          offenders.push(
            `${tool.name}: ${path.join(".") || "<root>"} is type:array without \`items\` — OpenAI will reject it with "array schema missing items"`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Issue #377: tool descriptions are agent-facing free-form strings. A future
  // edit that accidentally introduces an unescaped backtick, a control
  // character, or an empty string would either break JSON serialization on
  // the wire or starve the LLM of guidance for that tool. This is a cheap
  // smoke test that catches both classes of regression in one shot.
  it("every tool has a non-empty description that survives JSON round-trip", () => {
    const tools = collectAllTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expect(
        typeof tool.description,
        `${tool.name}: description must be a string`,
      ).toBe("string");
      expect(
        tool.description.length,
        `${tool.name}: description must be non-empty`,
      ).toBeGreaterThan(0);

      // Round-trip catches non-serializable values (functions, undefined),
      // and the equality check catches silent re-encoding glitches.
      const roundTripped = JSON.parse(JSON.stringify({ d: tool.description }));
      expect(roundTripped.d).toBe(tool.description);
    }
  });
});
