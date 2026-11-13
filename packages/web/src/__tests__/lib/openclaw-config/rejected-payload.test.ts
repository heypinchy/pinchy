import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_REJECTED_PAYLOADS,
  redactRejectedPayload,
  writeRejectedPayload,
} from "@/lib/openclaw-config/rejected-payload";

const payload = {
  gateway: { mode: "local", auth: { mode: "token", token: "GATEWAY-SECRET-TOKEN" } },
  plugins: {
    entries: {
      "pinchy-files": { enabled: true, config: { gatewayToken: "PLUGIN-SECRET-1", agents: {} } },
      "pinchy-odoo": { enabled: true, config: { gatewayToken: "PLUGIN-SECRET-2" } },
    },
  },
  channels: { telegram: { accounts: { a1: { botToken: "123456:BOT-SECRET" } } } },
  agents: { entries: { a1: { name: "Smithers" } } },
};

describe("redactRejectedPayload", () => {
  it("removes the gateway token, every plugin gatewayToken and every telegram botToken", () => {
    const out = redactRejectedPayload(JSON.stringify(payload, null, 2));
    expect(out).not.toMatch(/GATEWAY-SECRET-TOKEN|PLUGIN-SECRET|BOT-SECRET/);
  });

  it("keeps the rest of the payload so the postmortem stays useful", () => {
    const parsed = JSON.parse(redactRejectedPayload(JSON.stringify(payload)));
    expect(parsed.agents.entries.a1.name).toBe("Smithers");
    expect(parsed.gateway.mode).toBe("local");
    expect(parsed.plugins.entries["pinchy-files"].enabled).toBe(true);
  });

  it("never writes unparseable content verbatim (it could carry the tokens)", () => {
    const out = redactRejectedPayload('{"gateway":{"auth":{"token":"GATEWAY-SECRET-TOKEN"');
    expect(out).not.toContain("GATEWAY-SECRET-TOKEN");
  });
});

describe("writeRejectedPayload", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rejected-payload-"));
    configPath = join(dir, "openclaw.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rejected = () => readdirSync(dir).filter((f) => f.includes(".regenerate-rejected."));

  it("writes the file at 0600 with the tokens redacted", () => {
    const path = writeRejectedPayload(configPath, JSON.stringify(payload), "2026-11-13T10-00-00Z");
    expect(path).toBe(`${configPath}.regenerate-rejected.2026-11-13T10-00-00Z`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).not.toMatch(/SECRET/);
  });

  it("keeps only the newest MAX_REJECTED_PAYLOADS dumps", () => {
    for (let i = 0; i < MAX_REJECTED_PAYLOADS + 4; i++) {
      const ts = `2026-11-13T10-00-${String(i).padStart(2, "0")}-000Z`;
      writeRejectedPayload(configPath, "{}", ts);
    }
    const left = rejected().sort();
    expect(left).toHaveLength(MAX_REJECTED_PAYLOADS);
    expect(left.at(-1)).toContain(`10-00-${String(MAX_REJECTED_PAYLOADS + 3).padStart(2, "0")}`);
    expect(left[0]).toContain(`10-00-04`);
  });

  it("never touches the config itself or its siblings when pruning", () => {
    writeFileSync(configPath, "{}");
    writeFileSync(`${configPath}.bak`, "{}");
    for (let i = 0; i < MAX_REJECTED_PAYLOADS + 2; i++) {
      writeRejectedPayload(configPath, "{}", `2026-11-13T10-00-0${i}-000Z`);
    }
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining(["openclaw.json", "openclaw.json.bak"])
    );
  });

  it("does not throw when the directory is unwritable", () => {
    expect(() =>
      writeRejectedPayload(join(dir, "missing", "openclaw.json"), "{}", "2026-11-13T10-00-00Z")
    ).not.toThrow();
  });
});
