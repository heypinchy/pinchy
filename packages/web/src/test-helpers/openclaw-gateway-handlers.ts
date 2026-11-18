/**
 * OpenClaw's own gateway handlers, loaded from the pinned package's dist/, for
 * tests that must run a request through what a live gateway does to it rather
 * than through a fake that encodes our reading of its rules.
 *
 * The handlers are not part of OpenClaw's public exports, so these helpers find
 * the chunk that defines them. An OpenClaw bump that renames, splits or
 * duplicates one fails here loudly, never silently.
 */
import { expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

type Json = Record<string, unknown>;

type Respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
/** A gateway handler with the gateway's context already bound (`loadGatewayHandlers`). */
export type GatewayHandler = (opts: { params: Json; respond: Respond; client: null }) => unknown;

/** The pinned package's dist/ (`openclaw/plugin-sdk/config-runtime` is public and lives in dist/plugin-sdk/). */
export function openClawDist(): string {
  const require = createRequire(import.meta.url);
  return dirname(dirname(require.resolve("openclaw/plugin-sdk/config-runtime")));
}

/** The one dist/ chunk that exports `name` under that name. */
export async function importChunkExporting<T>(name: string): Promise<T> {
  const dist = openClawDist();
  const exports = new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}`);
  const exporting = readdirSync(dist).filter(
    (f) => f.endsWith(".js") && exports.test(readFileSync(join(dist, f), "utf-8"))
  );
  expect(exporting, `exactly one chunk in ${dist} must export ${name}`).toHaveLength(1);
  return (await import(pathToFileURL(join(dist, exporting[0])).href)) as T;
}

/**
 * The top-level function or const `name` from the one dist/ chunk that defines
 * it, under whatever name that chunk exports it: the bundler exports internals
 * under one-letter aliases (`getRuntimeConfigWriteApplication as x`), and
 * re-exports some from several chunks, so neither the name nor "the chunk
 * that exports it" finds them reliably.
 */
export async function importDefined<T>(name: string): Promise<T> {
  const dist = openClawDist();
  const defines = new RegExp(`^(?:(?:async )?function ${name}\\(|const ${name} = )`, "m");
  const defining = readdirSync(dist).filter(
    (f) => f.endsWith(".js") && defines.test(readFileSync(join(dist, f), "utf-8"))
  );
  expect(defining, `exactly one chunk in ${dist} must define ${name}`).toHaveLength(1);
  const source = readFileSync(join(dist, defining[0]), "utf-8");
  const exported = [...source.matchAll(/export \{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(","))
    .map((spec) => spec.trim().split(/\s+as\s+/))
    .find(([local]) => local === name);
  expect(exported, `${defining[0]} must export ${name}`).toBeDefined();
  const mod = (await import(pathToFileURL(join(dist, defining[0])).href)) as Record<string, T>;
  return mod[exported![1] ?? name];
}

let releaseWrites: () => void = () => {};

/** Ends the write claim `loadGatewayHandlers` set up. Call it in afterEach. */
export function releaseGatewayWrites(): void {
  releaseWrites();
  releaseWrites = () => {};
}

/**
 * OpenClaw's gateway `configHandlers` and `agentsHandlers`, bound to the parts
 * of the gateway's context they read. Load them after pointing
 * OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH at the test's directory.
 *
 * Since 2026.9, config.apply answers only once the running gateway has taken
 * the write: its config reloader claims every write to the config path and
 * settles it (`subscribeToWrites` in the managed reload loop). With no
 * reloader, a committed write is still answered "persisted but was not applied
 * to the active Gateway (unclaimed)". A write listener plays the reloader's
 * part here and settles every write "applied" — the hot reload itself is the
 * gateway's, not what these tests are about. The runtime config the agents
 * handlers check against is therefore the file as it stands.
 */
export async function loadGatewayHandlers(): Promise<Record<string, GatewayHandler>> {
  const configHandlers =
    await importDefined<Record<string, (opts: Json) => unknown>>("configHandlers");
  const agentsHandlers =
    await importDefined<Record<string, (opts: Json) => unknown>>("agentsHandlers");
  expect(Object.keys(configHandlers)).toEqual(
    expect.arrayContaining(["config.get", "config.apply"])
  );
  expect(Object.keys(agentsHandlers)).toEqual(expect.arrayContaining(["agents.delete"]));

  const loadProjector = await importDefined<(options: Json) => unknown>(
    "loadGatewayConfigRevisionProjector"
  );
  const writeApplication = await importDefined<
    (event: unknown) => { claim: () => { settle: (status: string) => void } | null } | undefined
  >("getRuntimeConfigWriteApplication");
  const { registerConfigWriteListener, loadConfig } = (await import(
    pathToFileURL(join(openClawDist(), "config", "config.js")).href
  )) as {
    registerConfigWriteListener: (listener: (event: unknown) => void) => () => void;
    loadConfig: (options: Json) => Json;
  };
  releaseGatewayWrites();
  releaseWrites = registerConfigWriteListener((event) =>
    writeApplication(event)?.claim()?.settle("applied")
  );

  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const context = {
    configRevisionProjector: loadProjector({ env: process.env }),
    getConfigReloaderHotReloadStatus: () => undefined,
    getRuntimeConfig: () => loadConfig({ pin: false }),
    logGateway: silent,
    // No cron jobs here; agents.delete removes an agent's jobs inside this.
    cron: {
      removeAgentJobsTransactional: async (_agentId: string, commit: () => Promise<unknown>) =>
        commit(),
    },
  };
  return Object.fromEntries(
    Object.entries({ ...configHandlers, ...agentsHandlers }).map(([method, handler]) => [
      method,
      (opts: { params: Json; respond: Respond; client: null }) => handler({ ...opts, context }),
    ])
  );
}

/** One gateway request: resolves with the response, or rejects the way openclaw-node's client does. */
export function gatewayRequest(handler: GatewayHandler, params: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    const respond: Respond = (ok, payload, error) =>
      ok ? resolve(payload as Json) : reject(new Error(error?.message ?? "request failed"));
    Promise.resolve(handler({ params, respond, client: null })).catch((err: unknown) =>
      reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}
