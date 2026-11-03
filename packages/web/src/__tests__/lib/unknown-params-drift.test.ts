/**
 * Drift-guard: every Pinchy plugin tool refuses a parameter it does not
 * declare, and the check doing it is one file, duplicated byte for byte into
 * every plugin that registers tools (`unknown-params.ts`). Plugins are
 * separate packages loaded by OpenClaw from their own directories, so none can
 * import another's copy.
 *
 * Why every tool and not only the write tools: any tool an agent may call can
 * be gated (the confirmation section offers every allowed tool), and a key the
 * tool never reads is still shown to the person approving the call. Six URLs
 * under `target`, `destination` and `targets` ahead of the one `url`
 * pinchy_web_fetch reads take the space the approval prompt has for naming
 * hosts — the call carries nothing the tool does not read, or it does not run.
 *
 * The guard registers each plugin against a recording API and checks what
 * OpenClaw would receive, not what the source looks like: every tool the
 * manifest declares is registered through the refusing wrapper.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_PINCHY_PLUGINS, PLUGINS_DIR, loadManifest } from "./plugin-tool-extraction";
import {
  refusesUnknownParams,
  refusingUnknownParams,
} from "../../../../plugins/pinchy-web/unknown-params";

const TOOL_PLUGINS = KNOWN_PINCHY_PLUGINS.filter(
  (id) => (loadManifest(id).contracts?.tools ?? []).length > 0
);

const copyOf = (plugin: string) => join(PLUGINS_DIR, plugin, "unknown-params.ts");

describe("unknown-params.ts drift guard", () => {
  it("finds the plugins that register tools", () => {
    // A broken manifest walk would otherwise pass every check below in silence.
    expect(TOOL_PLUGINS.length).toBeGreaterThanOrEqual(7);
    expect(TOOL_PLUGINS).toContain("pinchy-web");
  });

  it.each(TOOL_PLUGINS)("%s carries the copy", (plugin) => {
    expect(existsSync(copyOf(plugin)), `${plugin}/unknown-params.ts is missing`).toBe(true);
  });

  it("is identical in every plugin that carries it", () => {
    const [first, ...rest] = TOOL_PLUGINS.map((plugin) => readFileSync(copyOf(plugin), "utf8"));
    expect(first).toContain("export function unknownParams(");
    for (const copy of rest) expect(copy).toBe(first);
  });

  it.each(TOOL_PLUGINS)(
    "%s registers every tool it declares through the refusing wrapper",
    async (plugin) => {
      const { default: mod } = (await import(
        /* @vite-ignore */ join(PLUGINS_DIR, plugin, "index.ts")
      )) as { default: { register(api: unknown): void } };
      const registered = new Map<string, unknown>();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mod.register({
          pluginConfig: {
            apiBaseUrl: "http://pinchy.test",
            gatewayToken: "token",
            connectionId: "conn",
            docsPath: "/nonexistent",
            agents: {},
          },
          logger: { info() {}, warn() {}, error() {} },
          registerTool(factory: unknown, opts?: { name?: string }) {
            registered.set(opts?.name ?? "", factory);
          },
        });
      } finally {
        warn.mockRestore();
      }
      const declared = loadManifest(plugin).contracts?.tools ?? [];
      for (const tool of declared) {
        expect(registered.has(tool), `${plugin} declares ${tool} but did not register it`).toBe(
          true
        );
        expect(
          refusesUnknownParams(registered.get(tool)),
          `${plugin}: ${tool} is not registered through refusingUnknownParams(api)`
        ).toBe(true);
      }
    }
  );
});

describe("refusingUnknownParams", () => {
  type Result = { isError?: boolean; content: { text: string }[]; details?: unknown };
  const execute = vi.fn(
    async (_toolCallId: string, _params: Record<string, unknown>): Promise<Result> => ({
      content: [{ text: "fetched" }],
    })
  );
  const tool = {
    name: "pinchy_web_fetch",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    execute,
  };

  function wrapped() {
    let factory: ((ctx: unknown) => typeof tool | null) | undefined;
    const api = refusingUnknownParams({
      pluginConfig: { live: true },
      registerTool(f: (ctx: unknown) => typeof tool | null) {
        factory = f;
      },
    });
    api.registerTool(() => tool);
    return { api, tool: factory!({ agentId: "a1" })! };
  }

  it("declares additionalProperties: false, so the runtime refuses extras first", () => {
    expect(wrapped().tool.parameters).toMatchObject({ additionalProperties: false });
    // The tool's own schema object is not changed for anyone else holding it.
    expect(tool.parameters).not.toHaveProperty("additionalProperties");
  });

  it("refuses a call carrying a key the tool does not declare, before the tool runs", async () => {
    execute.mockClear();
    const result = (await wrapped().tool.execute("call-1", {
      target: "https://a.firma.at/",
      url: "https://evil.com/exfil",
    })) as Result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"target"');
    expect(result.content[0].text).toMatch(/does not take/);
    // Only how many: a key is free text the model chose.
    expect(result.details).toEqual({ error: "Refused: unknown parameters", unknownParams: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs a call that uses only declared parameters", async () => {
    execute.mockClear();
    const result = (await wrapped().tool.execute("call-1", { url: "https://firma.at/" })) as Result;
    expect(result.content[0].text).toBe("fetched");
    expect(execute).toHaveBeenCalledWith("call-1", { url: "https://firma.at/" });
  });

  it("passes a factory's null through, and leaves the rest of the API as it is", () => {
    let factory: ((ctx: unknown) => unknown) | undefined;
    const api = refusingUnknownParams({
      pluginConfig: { live: true },
      registerTool(f: (ctx: unknown) => unknown) {
        factory = f;
      },
    });
    api.registerTool(() => null);
    expect(factory!({})).toBeNull();
    expect(api.pluginConfig).toEqual({ live: true });
  });
});
