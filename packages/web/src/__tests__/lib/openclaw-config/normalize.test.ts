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
});
