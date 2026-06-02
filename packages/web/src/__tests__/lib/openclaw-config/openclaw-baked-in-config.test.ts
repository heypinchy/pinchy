// @vitest-environment node
/**
 * Validates that config/openclaw.json (the file baked into the Docker image
 * and copied to the openclaw-config named volume on first container start)
 * contains all fields that Pinchy writes on its first config.apply call.
 *
 * Why this matters:
 *   OC captures `currentCompareConfig` (= `startupLastGoodSnapshot.sourceConfig`)
 *   during startup. The reload handler diffs incoming config.apply payloads
 *   against `currentCompareConfig` to decide whether a gateway restart is needed.
 *   If the baked-in config is missing any field that Pinchy adds on first apply,
 *   the reload handler detects a diff and triggers a restart. During that in-
 *   process restart, OC's `ensureGatewayStartupAuth` uses the stale
 *   `initialSnapshotRead` (captured before the auth token was written), sees an
 *   empty token, and tries to write it — but Pinchy's concurrent write already
 *   changed the hash, causing ConfigMutationConflictError.
 *
 *   Reload rules (BASE_RELOAD_RULES_TAIL in OC source):
 *     gateway   → restart
 *     discovery → restart
 *     canvasHost → restart
 *     update    → restart (no rule → default)
 *
 *   All four sections must be present in the baked-in config with Pinchy's
 *   expected stable values so the first config.apply is a no-op diff for these
 *   paths. See openclaw#75534 and CI failures in PR #279.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("config/openclaw.json (baked-in config)", () => {
  let config: Record<string, unknown>;

  beforeAll(() => {
    // Resolve relative to this test file: 6 levels up to repo root, then config/
    // __dirname = packages/web/src/__tests__/lib/openclaw-config
    const path = resolve(__dirname, "../../../../../../config/openclaw.json");
    config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  });

  it("has gateway.controlUi.enabled: false — prevents restart-triggering diff on first config.apply", () => {
    const gateway = config.gateway as Record<string, unknown>;
    expect(gateway, "config.gateway must exist").toBeDefined();
    const controlUi = gateway.controlUi as Record<string, unknown> | undefined;
    expect(controlUi, "config.gateway.controlUi must exist").toBeDefined();
    expect(controlUi!.enabled).toBe(false);
  });

  it("has gateway.controlUi.allowedOrigins — prevents OC's in-memory seed from diffing on reload", () => {
    // OpenClaw 2026.2.26+ seeds gateway.controlUi.allowedOrigins in memory for a
    // bind:"lan" gateway but never persists it. Baking it in keeps OC's reload
    // diff empty for controlUi so an agents-only regenerate stays a hot reload
    // instead of cascading into a SIGUSR1 restart (the setup-wizard "unknown
    // agent id" / #193 flake on 2026.5.28).
    const gateway = config.gateway as Record<string, unknown>;
    const controlUi = gateway.controlUi as Record<string, unknown> | undefined;
    expect(controlUi!.allowedOrigins, "controlUi.allowedOrigins must be baked in").toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("has discovery.mdns.mode: 'off' — prevents restart-triggering diff on first config.apply", () => {
    const discovery = config.discovery as Record<string, unknown> | undefined;
    expect(discovery, "config.discovery must exist").toBeDefined();
    const mdns = discovery!.mdns as Record<string, unknown> | undefined;
    expect(mdns, "config.discovery.mdns must exist").toBeDefined();
    expect(mdns!.mode).toBe("off");
  });

  it("has update.checkOnStart: false — prevents restart-triggering diff on first config.apply", () => {
    const update = config.update as Record<string, unknown> | undefined;
    expect(update, "config.update must exist").toBeDefined();
    expect(update!.checkOnStart).toBe(false);
  });

  it("has canvasHost.enabled: false — prevents restart-triggering diff on first config.apply", () => {
    const canvasHost = config.canvasHost as Record<string, unknown> | undefined;
    expect(canvasHost, "config.canvasHost must exist").toBeDefined();
    expect(canvasHost!.enabled).toBe(false);
  });
});
