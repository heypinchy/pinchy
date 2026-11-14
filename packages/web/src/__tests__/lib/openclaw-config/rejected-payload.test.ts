import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_REJECTED_PAYLOADS,
  redactRejectedPayload,
  sweepRejectedPayloads,
  sweepRejectedPayloadsOnce,
  _resetRejectedPayloadSweep,
  writeRejectedPayload,
} from "@/lib/openclaw-config/rejected-payload";

/** Mode and content from one open file, so both describe the same inode. */
function readModeAndContent(path: string): { mode: number; content: string } {
  const fd = openSync(path, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, content: readFileSync(fd, "utf-8") };
  } finally {
    closeSync(fd);
  }
}

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

  it("redacts by key name, anywhere in the tree", () => {
    const out = redactRejectedPayload(
      JSON.stringify({
        a: { b: { apiKey: "K1", api_key: "K2", password: "P1", clientSecret: "S1" } },
        list: [{ Authorization: "Bearer A1", accessToken: "T1" }],
        keep: "visible",
      })
    );
    expect(out).not.toMatch(/K1|K2|P1|S1|A1|T1/);
    expect(out).toContain("visible");
  });

  it("strips userinfo and query strings from URL values", () => {
    const out = redactRejectedPayload(
      JSON.stringify({
        models: {
          providers: { x: { baseUrl: "https://user:pw-SECRET@llm.example/v1?key=Q-SECRET" } },
        },
      })
    );
    expect(out).not.toMatch(/pw-SECRET|Q-SECRET|user:/);
    expect(out).toContain("llm.example/v1");
  });

  it("omits the dump when the plaintext scanner still finds a provider key", () => {
    const out = redactRejectedPayload(
      JSON.stringify({ note: { value: "sk-ant-abcdefghijklmnopqrstuvwxyz" } })
    );
    expect(out).not.toContain("sk-ant-");
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
    const written = readModeAndContent(path);
    expect(written.mode).toBe(0o600);
    expect(written.content).not.toMatch(/SECRET/);
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

describe("sweepRejectedPayloads (dumps left by older versions)", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rejected-sweep-"));
    configPath = join(dir, "openclaw.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const legacy = (stamp: string) => {
    const path = `${configPath}.regenerate-rejected.${stamp}`;
    writeFileSync(path, JSON.stringify(payload), { mode: 0o644 });
    return path;
  };

  it("deletes dumps beyond the newest MAX_REJECTED_PAYLOADS", () => {
    for (let i = 0; i < MAX_REJECTED_PAYLOADS + 3; i++) legacy(`2026-01-0${i}`);
    sweepRejectedPayloads(configPath);
    expect(readdirSync(dir)).toHaveLength(MAX_REJECTED_PAYLOADS);
  });

  it("redacts and chmods the dumps it keeps", () => {
    const path = legacy("2026-01-01");
    sweepRejectedPayloads(configPath);
    const swept = readModeAndContent(path);
    expect(swept.mode).toBe(0o600);
    expect(swept.content).not.toMatch(/SECRET/);
  });

  it("does nothing, quietly, when the directory does not exist", () => {
    expect(() => sweepRejectedPayloads(join(dir, "nope", "openclaw.json"))).not.toThrow();
  });
});

describe("sweepRejectedPayloadsOnce", () => {
  it("sweeps on the first call only", () => {
    const dir = mkdtempSync(join(tmpdir(), "rejected-once-"));
    const configPath = join(dir, "openclaw.json");
    const dump = `${configPath}.regenerate-rejected.2026-01-01`;
    try {
      _resetRejectedPayloadSweep();
      writeFileSync(dump, JSON.stringify(payload), { mode: 0o644 });
      sweepRejectedPayloadsOnce(configPath);
      expect(readFileSync(dump, "utf-8")).not.toMatch(/SECRET/);
      writeFileSync(dump, JSON.stringify(payload), { mode: 0o644 });
      sweepRejectedPayloadsOnce(configPath);
      expect(readFileSync(dump, "utf-8")).toMatch(/SECRET/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rejected dumps: hostile directory entries, placeholders, key names", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rejected-hostile-"));
    configPath = join(dir, "openclaw.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("never writes through a symlinked dump: the target stays untouched, the link goes", () => {
    const target = join(dir, "target.key");
    writeFileSync(target, "ENCRYPTION-KEY-BYTES", { mode: 0o600 });
    const link = `${configPath}.regenerate-rejected.zzzz`;
    symlinkSync(target, link);
    sweepRejectedPayloads(configPath);
    expect(readFileSync(target, "utf-8")).toBe("ENCRYPTION-KEY-BYTES");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.includes("regenerate-rejected"))).toEqual([]);
  });

  it("drops a hardlinked dump without touching the other name", () => {
    const other = join(dir, "other.key");
    writeFileSync(other, "ENCRYPTION-KEY-BYTES", { mode: 0o644 });
    linkSync(other, `${configPath}.regenerate-rejected.aaaa`);
    sweepRejectedPayloads(configPath);
    expect(readFileSync(other, "utf-8")).toBe("ENCRYPTION-KEY-BYTES");
    expect(statSync(other).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).filter((n) => n.includes("regenerate-rejected"))).toEqual([]);
  });

  it("writeRejectedPayload does not follow a symlink planted at its name", () => {
    const target = join(dir, "target.key");
    writeFileSync(target, "ENCRYPTION-KEY-BYTES");
    symlinkSync(target, `${configPath}.regenerate-rejected.same`);
    writeRejectedPayload(configPath, "{}", "same");
    expect(readFileSync(target, "utf-8")).toBe("ENCRYPTION-KEY-BYTES");
  });

  it("keeps the omission reason across a sweep (placeholders are valid JSON)", () => {
    const first = redactRejectedPayload(
      JSON.stringify({ n: { v: "sk-ant-abcdefghijklmnopqrstuvwxyz" } })
    );
    expect(JSON.parse(first).omitted).toMatch(/plaintext provider key/);
    const path = `${configPath}.regenerate-rejected.2026-01-01`;
    writeFileSync(path, first);
    sweepRejectedPayloads(configPath);
    expect(JSON.parse(readFileSync(path, "utf-8")).omitted).toMatch(/plaintext provider key/);
    expect(JSON.parse(redactRejectedPayload("{nope")).omitted).toMatch(/unparseable/);
  });

  it("redacts x-api-key / api-key and the secrets block, but keeps token counts", () => {
    const out = JSON.parse(
      redactRejectedPayload(
        JSON.stringify({
          h: { "x-api-key": "XK", "api-key": "AK" },
          secrets: { p: "SP" },
          m: { maxTokens: 8192, contextTokens: 5 },
        })
      )
    );
    expect(JSON.stringify(out)).not.toMatch(/XK|AK|SP/);
    expect(out.m).toEqual({ maxTokens: 8192, contextTokens: 5 });
  });

  it("redacts credential keys OpenClaw channels carry through, wherever the word sits", () => {
    // Channel blocks an admin set directly in OpenClaw survive a regenerate
    // unchanged, and the plaintext scanner knows none of these formats.
    const out = redactRejectedPayload(
      JSON.stringify({
        channels: {
          feishu: { appSecret: "S1", encryptKey: "S2" },
          googlechat: { serviceAccount: { client_email: "x", private_key: "S3" } },
          other: { secretKey: "S4", secretAccessKey: "S5", privateKey: "S6", passphrase: "S7" },
          more: { apiKeys: ["S8"], tokens: ["S9"], clientSecret: "S10", cookie: "S11" },
        },
        usage: { maxTokens: 8192, tokenLimit: 3, secretRotationEnabled: true },
        smtp: { password: 482915, pinPassphrase: 7731 },
      })
    );
    expect(out).not.toMatch(/"S\d+"|482915|7731/);
    expect(JSON.parse(out).usage).toEqual({
      maxTokens: 8192,
      tokenLimit: 3,
      secretRotationEnabled: true,
    });
  });
});
