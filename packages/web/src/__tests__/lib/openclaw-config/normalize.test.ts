// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("fs");
vi.mock("@/lib/openclaw-config/paths", () => ({
  CONFIG_PATH: "/openclaw-config/openclaw.json",
}));

import * as fs from "fs";
import {
  redactUnchangedEnvForApply,
  supplementPayloadWithFileFields,
  OPENCLAW_REDACTED_SENTINEL,
} from "@/lib/openclaw-config/normalize";

const mockedReadFileSync = vi.mocked(fs.readFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe("redactUnchangedEnvForApply", () => {
  it("returns input unchanged when config file does not exist (cold start)", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const input = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    expect(redactUnchangedEnvForApply(input)).toBe(input);
  });

  it("redacts env key present in existing file — even when values differ (template vs resolved)", () => {
    // Simulates the OpenClaw#75534 scenario: existing file has the RESOLVED key
    // (sk-ant-...) after OpenClaw expanded the template; new config has template.
    // The sentinel prevents a spurious env.* restart.
    const existing = JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-resolvedvalue" } });
    mockedReadFileSync.mockReturnValue(existing as unknown as Buffer);

    const newContent = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    const result = JSON.parse(redactUnchangedEnvForApply(newContent));

    expect(result.env.ANTHROPIC_API_KEY).toBe(OPENCLAW_REDACTED_SENTINEL);
  });

  it("redacts env key when both files have the same template value", () => {
    const existing = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    mockedReadFileSync.mockReturnValue(existing as unknown as Buffer);

    const newContent = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    const result = JSON.parse(redactUnchangedEnvForApply(newContent));

    expect(result.env.ANTHROPIC_API_KEY).toBe(OPENCLAW_REDACTED_SENTINEL);
  });

  it("does NOT redact a new env key absent from the existing file", () => {
    const existing = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    mockedReadFileSync.mockReturnValue(existing as unknown as Buffer);

    const newContent = JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
    });
    const result = JSON.parse(redactUnchangedEnvForApply(newContent));

    expect(result.env.ANTHROPIC_API_KEY).toBe(OPENCLAW_REDACTED_SENTINEL);
    expect(result.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
  });

  it("returns input unchanged when existing file has no env section", () => {
    const existing = JSON.stringify({ agents: { list: [] } });
    mockedReadFileSync.mockReturnValue(existing as unknown as Buffer);

    const newContent = JSON.stringify({ env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } });
    const result = JSON.parse(redactUnchangedEnvForApply(newContent));

    // New key not in existing → not redacted
    expect(result.env.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
  });
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
