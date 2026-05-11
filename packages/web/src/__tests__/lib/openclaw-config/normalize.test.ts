// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("fs");
vi.mock("@/lib/openclaw-config/paths", () => ({
  CONFIG_PATH: "/openclaw-config/openclaw.json",
}));

import * as fs from "fs";
import {
  supplementPayloadWithFileFields,
  supplementPayloadWithOcConfig,
  configsAreEquivalentUpToOpenClawMetadata,
} from "@/lib/openclaw-config/normalize";

const mockedReadFileSync = vi.mocked(fs.readFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe("supplementPayloadWithFileFields", () => {
  it("returns payload unchanged when file does not exist", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const payload = JSON.stringify({ plugins: { allow: ["pinchy-audit"], entries: {} } });
    expect(supplementPayloadWithFileFields(payload)).toBe(payload);
  });

  it("adds non-pinchy plugins.allow entries from file that are absent from payload", () => {
    // Simulates OpenClaw auto-adding "anthropic" to plugins.allow after restart.
    const file = JSON.stringify({
      plugins: { allow: ["pinchy-audit", "anthropic", "telegram"] },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({ plugins: { allow: ["pinchy-audit"] } });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.plugins.allow).toContain("anthropic");
    expect(result.plugins.allow).toContain("telegram");
    expect(result.plugins.allow).toContain("pinchy-audit");
  });

  it("does NOT add pinchy-* entries from file plugins.allow", () => {
    // A stale pinchy-files entry in the file should not be resurrected.
    const file = JSON.stringify({
      plugins: { allow: ["pinchy-files", "anthropic"] },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({ plugins: { allow: [] } });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.plugins.allow).not.toContain("pinchy-files");
    expect(result.plugins.allow).toContain("anthropic");
  });

  it("adds non-pinchy plugins.entries from file that are absent from payload", () => {
    // Simulates OpenClaw writing plugins.entries.anthropic = {enabled:true} on auto-enable.
    const file = JSON.stringify({
      plugins: {
        allow: ["anthropic"],
        entries: { anthropic: { enabled: true } },
      },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      plugins: { allow: ["pinchy-audit"], entries: { "pinchy-audit": { enabled: true } } },
    });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.plugins.entries.anthropic).toEqual({ enabled: true });
    expect(result.plugins.entries["pinchy-audit"]).toEqual({ enabled: true }); // untouched
  });

  it("does NOT overwrite existing plugins.entries in payload with file values", () => {
    const file = JSON.stringify({
      plugins: {
        entries: { "pinchy-audit": { enabled: false, staleField: "old" } },
      },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      plugins: { allow: [], entries: { "pinchy-audit": { enabled: true } } },
    });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    // Payload value wins — not overwritten by stale file value
    expect(result.plugins.entries["pinchy-audit"]).toEqual({ enabled: true });
  });

  it("adds gateway.controlUi fields from file that are absent from payload", () => {
    // Simulates OpenClaw writing gateway.controlUi.allowedOrigins after startup.
    const file = JSON.stringify({
      gateway: {
        mode: "local",
        controlUi: { allowedOrigins: ["http://localhost:18789"] },
      },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({ gateway: { mode: "local", auth: { token: "tok" } } });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.gateway.controlUi).toEqual({ allowedOrigins: ["http://localhost:18789"] });
    expect(result.gateway.auth).toEqual({ token: "tok" }); // untouched
  });

  it("does NOT overwrite existing gateway.controlUi fields in payload", () => {
    const file = JSON.stringify({
      gateway: { controlUi: { allowedOrigins: ["old"] } },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      gateway: { controlUi: { allowedOrigins: ["new"] } },
    });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.gateway.controlUi.allowedOrigins).toEqual(["new"]);
  });

  it("returns payload unchanged when file has nothing to supplement", () => {
    const file = JSON.stringify({ agents: { list: [] } });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      gateway: { mode: "local" },
      plugins: { allow: ["pinchy-audit"] },
    });
    // Should be identical string when nothing changes
    const result = supplementPayloadWithFileFields(payload);
    expect(JSON.parse(result)).toEqual(JSON.parse(payload));
  });
});

describe("supplementPayloadWithOcConfig", () => {
  it("adds meta from OC config when absent from payload — prevents missing-meta-before-write", () => {
    // Simulates the case where readExistingConfig() returned {} (EACCES race),
    // so build.ts omitted meta from the payload. Without meta the payload triggers
    // OpenClaw's missing-meta-before-write anomaly → cascading restarts.
    const ocConfig = {
      hash: "abc123",
      meta: { version: "4.27.0", generatedAt: "2025-01-01T00:00:00Z", lastTouchedAt: "T2" },
      gateway: { mode: "local", controlUi: { allowedOrigins: ["http://localhost:18789"] } },
    };
    const payload = JSON.stringify({ gateway: { mode: "local", auth: { token: "tok" } } });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.meta).toEqual(ocConfig.meta);
    expect(result.gateway.auth).toEqual({ token: "tok" }); // Pinchy field untouched
  });

  it("does NOT overwrite existing meta in payload", () => {
    const ocConfig = { hash: "x", meta: { version: "4.27.0", lastTouchedAt: "T2" } };
    const payload = JSON.stringify({ meta: { version: "4.27.0", lastTouchedAt: "T1" } });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.meta.lastTouchedAt).toBe("T1"); // payload wins
  });

  it("adds gateway.controlUi from OC config (avoids file-read race for controlUi)", () => {
    const ocConfig = {
      hash: "x",
      gateway: { controlUi: { allowedOrigins: ["http://localhost:18789"] } },
    };
    const payload = JSON.stringify({ gateway: { mode: "local" } });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.gateway.controlUi).toEqual({ allowedOrigins: ["http://localhost:18789"] });
  });

  it("adds non-pinchy plugins.entries from OC config", () => {
    const ocConfig = {
      hash: "x",
      plugins: { allow: ["anthropic"], entries: { anthropic: { enabled: true } } },
    };
    const payload = JSON.stringify({ plugins: { allow: ["pinchy-audit"], entries: {} } });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.plugins.entries.anthropic).toEqual({ enabled: true });
  });

  it("adds non-pinchy plugins.allow entries from OC config", () => {
    const ocConfig = { hash: "x", plugins: { allow: ["pinchy-audit", "anthropic"] } };
    const payload = JSON.stringify({ plugins: { allow: ["pinchy-audit"] } });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.plugins.allow).toContain("anthropic");
  });

  it("adds models.providers.* baseUrl from OC config when absent from payload", () => {
    // OC 4.27 with ANTHROPIC_BASE_URL env var: OC sets baseUrl in its in-memory config.
    // Pinchy's payload omits baseUrl (it only writes apiKey + models). Without
    // supplementing, config.apply fails with
    // "anthropic.baseUrl: Invalid input: expected string, received undefined".
    const ocConfig = {
      hash: "x",
      models: {
        providers: {
          anthropic: { baseUrl: "https://mock.api:443", apiKey: "sk-ant-resolved" },
        },
      },
    };
    const payload = JSON.stringify({
      models: {
        providers: {
          anthropic: {
            apiKey: { $secretRef: "/providers/anthropic/apiKey" },
            models: [],
          },
        },
      },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.models.providers.anthropic.baseUrl).toBe("https://mock.api:443");
    expect(result.models.providers.anthropic.apiKey).toEqual({
      $secretRef: "/providers/anthropic/apiKey",
    });
  });

  it("does NOT overwrite existing models.providers.* baseUrl in payload", () => {
    const ocConfig = {
      hash: "x",
      models: { providers: { anthropic: { baseUrl: "https://oc-api.anthropic.com" } } },
    };
    const payload = JSON.stringify({
      models: { providers: { anthropic: { baseUrl: "https://custom.proxy" } } },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.models.providers.anthropic.baseUrl).toBe("https://custom.proxy");
  });

  it("adds baseUrl via supplementPayloadWithFileFields as well", () => {
    // Same scenario but sourced from the file on disk (fallback path).
    const file = JSON.stringify({
      models: {
        providers: { anthropic: { baseUrl: "https://mock.api:443", apiKey: "sk-ant-resolved" } },
      },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      models: {
        providers: { anthropic: { apiKey: { $secretRef: "/providers/anthropic/apiKey" } } },
      },
    });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.models.providers.anthropic.baseUrl).toBe("https://mock.api:443");
  });

  // OC 5.x enriches discovery, update, canvasHost with runtime subfields.
  // config.apply writes the payload to the file, and the config reloader diffs
  // OC's enriched currentCompareConfig against the new file. Missing subfields
  // → diff detected → restart triggered → ConfigMutationConflictError on in-
  // process restart (stale hash). These tests verify that supplementation
  // preserves OC-enriched subfields for all three sections.

  it("deep-supplements discovery from OC config — preserves OC-enriched subfields while keeping Pinchy values", () => {
    // OC 5.x enriches discovery.mdns with runtime state (lastAnnouncedAt, etc.)
    // and writes discovery.peers. Pinchy only writes { mdns: { mode: "off" } }.
    // Without supplementing, config.apply payload → file → reloader diff
    // detects discovery change → restart.
    const ocConfig = {
      hash: "x",
      discovery: {
        mdns: {
          mode: "off", // Pinchy owns this
          lastAnnouncedAt: "2026-05-04T10:00:00Z", // OC-enriched
          peers: ["peer1"], // OC-enriched
        },
        peers: [{ id: "p1" }], // OC-enriched top-level
      },
    };
    // Pinchy's payload: only sets mdns.mode
    const payload = JSON.stringify({
      discovery: { mdns: { mode: "off" } },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    // Pinchy-owned value preserved
    expect(result.discovery.mdns.mode).toBe("off");
    // OC-enriched nested subfields added
    expect(result.discovery.mdns.lastAnnouncedAt).toBe("2026-05-04T10:00:00Z");
    expect(result.discovery.mdns.peers).toEqual(["peer1"]);
    // OC-enriched top-level discovery field added
    expect(result.discovery.peers).toEqual([{ id: "p1" }]);
  });

  it("deep-supplements update from OC config — preserves Pinchy checkOnStart: false", () => {
    const ocConfig = {
      hash: "x",
      update: {
        checkOnStart: false, // Pinchy owns this
        lastCheckedAt: "2026-05-04T10:00:00Z", // OC-enriched
        channel: "stable", // OC default
      },
    };
    const payload = JSON.stringify({
      update: { checkOnStart: false },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.update.checkOnStart).toBe(false); // Pinchy value preserved
    expect(result.update.lastCheckedAt).toBe("2026-05-04T10:00:00Z");
    expect(result.update.channel).toBe("stable");
  });

  it("deep-supplements canvasHost from OC config — preserves Pinchy enabled: false", () => {
    const ocConfig = {
      hash: "x",
      canvasHost: {
        enabled: false, // Pinchy owns this
        port: 18790, // OC-enriched
        boundAddr: "0.0.0.0", // OC-enriched
      },
    };
    const payload = JSON.stringify({
      canvasHost: { enabled: false },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.canvasHost.enabled).toBe(false); // Pinchy value preserved
    expect(result.canvasHost.port).toBe(18790);
    expect(result.canvasHost.boundAddr).toBe("0.0.0.0");
  });

  it("does NOT overwrite Pinchy-set values in discovery/update/canvasHost with OC values", () => {
    // Even if OC has a different value for a key Pinchy explicitly sets,
    // the payload (Pinchy's intent) takes precedence.
    const ocConfig = {
      hash: "x",
      discovery: { mdns: { mode: "on" } }, // OC says "on"
      update: { checkOnStart: true }, // OC says "true"
      canvasHost: { enabled: true }, // OC says "true"
    };
    const payload = JSON.stringify({
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      canvasHost: { enabled: false },
    });
    const result = JSON.parse(supplementPayloadWithOcConfig(payload, ocConfig));

    expect(result.discovery.mdns.mode).toBe("off");
    expect(result.update.checkOnStart).toBe(false);
    expect(result.canvasHost.enabled).toBe(false);
  });

  it("supplements discovery/update/canvasHost via file fallback (supplementPayloadWithFileFields)", () => {
    const file = JSON.stringify({
      discovery: {
        mdns: { mode: "off", lastAnnouncedAt: "2026-05-04T10:00:00Z" },
      },
      update: { checkOnStart: false, lastCheckedAt: "T1" },
      canvasHost: { enabled: false, port: 18790 },
    });
    mockedReadFileSync.mockReturnValue(file as unknown as Buffer);

    const payload = JSON.stringify({
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      canvasHost: { enabled: false },
    });
    const result = JSON.parse(supplementPayloadWithFileFields(payload));

    expect(result.discovery.mdns.lastAnnouncedAt).toBe("2026-05-04T10:00:00Z");
    expect(result.update.lastCheckedAt).toBe("T1");
    expect(result.canvasHost.port).toBe(18790);
  });
});

describe("configsAreEquivalentUpToOpenClawMetadata", () => {
  it("returns true for identical configs", () => {
    const cfg = JSON.stringify({ gateway: { mode: "local" }, agents: [] });
    expect(configsAreEquivalentUpToOpenClawMetadata(cfg, cfg)).toBe(true);
  });

  it("ignores meta.lastTouchedAt differences", () => {
    const a = JSON.stringify({
      meta: { version: "5.3", lastTouchedAt: "T1" },
      gateway: { mode: "local" },
    });
    const b = JSON.stringify({
      meta: { version: "5.3", lastTouchedAt: "T2" },
      gateway: { mode: "local" },
    });
    expect(configsAreEquivalentUpToOpenClawMetadata(a, b)).toBe(true);
  });

  it("compares semantically — key order does NOT matter", () => {
    // Pinchy builds its payload with object-literal ordering
    // (gateway/discovery/update/canvasHost/secrets/...). OC's
    // `config.get()` returns a snapshot OC serialized in its own order
    // (often differs by field). Both objects are semantically equal but
    // string-equality (the previous JSON.stringify==JSON.stringify
    // implementation) reported "differ" — the no-op-apply guard then
    // failed to fire and the wasted apply consumed an OC 5.3
    // config.apply rate-limit slot. isDeepStrictEqual tree-walks like
    // OC's own diff function and ignores key order.
    const a = JSON.stringify({
      gateway: { mode: "local", bind: "lan" },
      discovery: { mdns: { mode: "off" } },
    });
    const b = JSON.stringify({
      discovery: { mdns: { mode: "off" } },
      gateway: { bind: "lan", mode: "local" },
    });
    expect(configsAreEquivalentUpToOpenClawMetadata(a, b)).toBe(true);
  });

  it("detects real value differences", () => {
    const a = JSON.stringify({ gateway: { controlUi: { enabled: false } } });
    const b = JSON.stringify({ gateway: { controlUi: { enabled: true } } });
    expect(configsAreEquivalentUpToOpenClawMetadata(a, b)).toBe(false);
  });

  it("returns false on parse error", () => {
    expect(configsAreEquivalentUpToOpenClawMetadata("{not json", "{}")).toBe(false);
  });
});
