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
 *     update    → restart (no rule → default)
 *   plus the canvas plugin's host, `attachments` and `memory` (OpenClaw 2026.9;
 *   no rule → default restart).
 *
 *   All of them must be present in the baked-in config with Pinchy's
 *   expected stable values so the first config.apply is a no-op diff for these
 *   paths. See openclaw#75534 and CI failures in PR #279.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { MEMORY_EMBEDDING_MODEL_PATH, OPENCLAW_MEDIA_TTL_HOURS } from "@/lib/openclaw-config/paths";

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

  it("has the canvas plugin's host off — prevents restart-triggering diff on first config.apply", () => {
    // OpenClaw 2026.9 moved root `canvasHost` into the bundled canvas plugin's
    // config and refuses a file that still carries the root key.
    expect(config.canvasHost, "root canvasHost is retired").toBeUndefined();
    const plugins = config.plugins as Record<string, Record<string, Record<string, unknown>>>;
    const canvas = plugins?.entries?.canvas as { config?: { host?: { enabled?: unknown } } };
    expect(canvas?.config?.host?.enabled).toBe(false);
  });

  it("has memory-core's dreaming off — no dreaming cron before the first regenerate, no restart-triggering diff", () => {
    // OpenClaw 2026.8.1 turned grounded dreaming on by default, and memory-core
    // creates its nightly cron job at gateway start. Pinchy forces it off on
    // every regenerate (build.ts); baked in, the job never exists, and `plugins`
    // — restart-class — does not diff on the first config.apply.
    const plugins = config.plugins as Record<string, Record<string, Record<string, unknown>>>;
    const memoryCore = plugins?.entries?.["memory-core"] as {
      config?: { dreaming?: { enabled?: unknown } };
    };
    expect(memoryCore?.config?.dreaming?.enabled).toBe(false);
  });

  it("has Skill Workshop's autonomous mode off — no self-applied skills before the first regenerate", () => {
    const skills = config.skills as { workshop?: { autonomous?: { mode?: unknown } } } | undefined;
    expect(skills?.workshop?.autonomous?.mode).toBe("off");
  });

  it("limits session tools to the current session — no cross-session reach before the first regenerate", () => {
    const tools = config.tools as { sessions?: { visibility?: unknown } } | undefined;
    expect(tools?.sessions?.visibility).toBe("self");
  });

  it("has gateway.terminal.enabled: false — governance + prevents restart-triggering diff on first config.apply", () => {
    // OpenClaw 2026.7.1+ adds gateway.terminal.enabled, an interactive workspace
    // shell for admins. OC defaults it to false, but materializes the block in its
    // parsed compare config even when the file omits it — so baking it in keeps
    // the first config.apply a no-op diff for the restart-class `gateway` path
    // (instead of a missing-then-added diff that cascades into a SIGUSR1 restart).
    // Pinchy also pins it off as explicit governance: an uncontrolled side channel
    // that bypasses permission checks + audit trail.
    const gateway = config.gateway as Record<string, unknown>;
    const terminal = gateway.terminal as Record<string, unknown> | undefined;
    expect(terminal, "config.gateway.terminal must exist").toBeDefined();
    expect(terminal!.enabled).toBe(false);
  });

  it("has attachments.ttlHours: 48 — prevents restart-triggering diff on first config.apply", () => {
    // OpenClaw has no reload rule for `attachments` (root `media.ttlHours` until
    // 2026.8), so it treats any change there as restart-class. Pinchy writes it
    // on every regenerate (see build.ts); without it baked in, a fresh install's
    // first regenerate is an in-process gateway restart that aborts the run in
    // flight.
    expect(config.media, "root media is retired").toBeUndefined();
    const attachments = config.attachments as Record<string, unknown> | undefined;
    expect(attachments, "config.attachments must exist").toBeDefined();
    expect(attachments!.ttlHours).toBe(OPENCLAW_MEDIA_TTL_HOURS);
  });

  it("has memory.search pinned to the bundled local model — prevents restart-triggering diff on first config.apply", () => {
    // `memory` is restart-class in OpenClaw 2026.9 (it was hot as
    // agents.defaults.memorySearch), and Pinchy writes it on every regenerate.
    const memory = config.memory as { search?: Record<string, unknown> } | undefined;
    expect(memory?.search?.provider).toBe("local");
    expect((memory?.search?.local as Record<string, unknown>)?.modelPath).toBe(
      MEMORY_EMBEDDING_MODEL_PATH
    );
  });
});
