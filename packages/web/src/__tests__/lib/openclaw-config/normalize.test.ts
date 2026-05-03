// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("fs");
vi.mock("@/lib/openclaw-config/paths", () => ({
  CONFIG_PATH: "/openclaw-config/openclaw.json",
}));

import * as fs from "fs";
import {
  redactUnchangedEnvForApply,
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
