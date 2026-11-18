import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertNoPlaintextSecrets,
  findNewPlaintextSecrets,
  findPlaintextSecrets,
  _resetInheritedSecretReports,
} from "@/lib/openclaw-plaintext-scanner";

// Shape-accurate Ollama Cloud key: 32 hex + "." + ≥16 base62.
const LEGACY_KEY = "d09762adf39c4d1cbdca5f5fc7ca13d5.JyGHlyB0m9yYcpIVkavQIBH7";
const OTHER_KEY = "1a2b3c4d5e6f70718293a4b5c6d7e8f9.ZqWx0EcRvTyBnUmIoPlK9876";

describe("findPlaintextSecrets", () => {
  it("flags Anthropic-style keys", () => {
    expect(findPlaintextSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-abcdef1234567890" } })).toEqual(
      [{ path: "env.ANTHROPIC_API_KEY", pattern: "anthropic" }]
    );
  });

  it("flags OpenAI-style keys", () => {
    expect(
      findPlaintextSecrets({ env: { OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrst" } })
    ).toEqual([{ path: "env.OPENAI_API_KEY", pattern: "openai-generic" }]);
  });

  it("flags Ollama Cloud keys", () => {
    // Real format: 32 hex chars + "." + ≥16 base62 chars (observed in
    // production secrets.json). The leak path that worried us: a future
    // refactor that bypasses SecretRef and lands the raw key in env.*
    // or a provider apiKey field — the scanner has to catch it.
    expect(
      findPlaintextSecrets({
        providers: {
          "ollama-cloud": { apiKey: "d09762adf39c4d1cbdca5f5fc7ca13d5.JyGHlyB0m9yYcpIVkavQIBH7" },
        },
      })
    ).toEqual([{ path: "providers.ollama-cloud.apiKey", pattern: "ollama-cloud" }]);
  });

  it("accepts Telegram bot tokens as plain strings (OpenClaw 2026.4.26 does not support SecretRef in channel configs)", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: { a1: { botToken: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" } },
        },
      },
    };
    expect(findPlaintextSecrets(cfg)).toHaveLength(0);
  });

  it("accepts SecretRef objects (no match)", () => {
    const cfg = {
      env: {
        ANTHROPIC_API_KEY: {
          source: "file",
          provider: "pinchy",
          id: "/providers/anthropic/apiKey",
        },
      },
    };
    expect(findPlaintextSecrets(cfg)).toEqual([]);
  });

  it("accepts arbitrary OpenAI-compatible custom keys (#894 adds no new prefix pattern)", () => {
    // #894 lets admins configure providers with arbitrary keys. The emission
    // path writes a SecretRef (raw key stays in the secrets bundle — see the
    // "OpenAI-compatible custom providers (#894)" block in openclaw-config.test),
    // and the scanner deliberately adds NO pattern for these keys. A JWT-shaped
    // bearer token is not a known provider prefix, so an arbitrary compatible
    // key does not trip the scanner even if it were embedded in a tree...
    expect(
      findPlaintextSecrets({
        models: {
          providers: {
            "swisscom-ai": {
              apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.sig1234567890",
            },
          },
        },
      })
    ).toEqual([]);
    // ...and the SecretRef the emission path actually produces for such a
    // provider is likewise clean.
    expect(
      findPlaintextSecrets({
        models: {
          providers: {
            "swisscom-ai": {
              apiKey: { source: "file", provider: "pinchy", id: "/providers/swisscom-ai/apiKey" },
            },
          },
        },
      })
    ).toEqual([]);
  });

  it("accepts ${VAR} env templates (no match)", () => {
    // OpenClaw rejects SecretRef objects in env.* — Pinchy writes ${VAR}
    // template strings instead. The scanner must let those through.
    const cfg = {
      env: {
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
    };
    expect(findPlaintextSecrets(cfg)).toEqual([]);
  });

  it("returns empty for clean configs", () => {
    expect(findPlaintextSecrets({ gateway: { mode: "local", bind: "lan" } })).toEqual([]);
  });
});

// #884: a write is only a leak when it INTRODUCES the plaintext. Installs
// upgraded from a pre-SecretRef Pinchy still carry a top-level `env` block with
// plaintext provider keys, and targeted writers (the boot seeds, the Telegram
// channel writer) spread the whole on-disk config through verbatim. Judging
// those writes by the absolute scan permanently wedged them — the write was
// rejected, the secret stayed on disk anyway, and the restart-class overrides
// were never seeded.
describe("findNewPlaintextSecrets", () => {
  it("ignores a secret the previous config already carried at the same path", () => {
    const previous = {
      env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY },
      models: { providers: { "ollama-cloud": { apiKey: LEGACY_KEY } } },
    };
    const next = { ...previous, update: { checkOnStart: false } };

    expect(findNewPlaintextSecrets(next, previous)).toEqual([]);
  });

  it("flags a different value at a path that already leaked", () => {
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };
    const next = { env: { OLLAMA_CLOUD_API_KEY: OTHER_KEY } };

    expect(findNewPlaintextSecrets(next, previous)).toEqual([
      { path: "env.OLLAMA_CLOUD_API_KEY", pattern: "ollama-cloud" },
    ]);
  });

  it("flags a secret at a path the previous config did not carry", () => {
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };
    const next = {
      env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY },
      models: { providers: { "ollama-cloud": { apiKey: LEGACY_KEY } } },
    };

    expect(findNewPlaintextSecrets(next, previous)).toEqual([
      { path: "models.providers.ollama-cloud.apiKey", pattern: "ollama-cloud" },
    ]);
  });

  it("flags everything when there is no previous config (cold start)", () => {
    const next = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };

    expect(findNewPlaintextSecrets(next, undefined)).toEqual([
      { path: "env.OLLAMA_CLOUD_API_KEY", pattern: "ollama-cloud" },
    ]);
  });
});

describe("assertNoPlaintextSecrets", () => {
  // The once-per-process report dedup is module state; clear it so the tests
  // below don't silence each other through it.
  beforeEach(() => {
    _resetInheritedSecretReports();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when plaintext found", () => {
    expect(() =>
      assertNoPlaintextSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-leaked1234567890" } })
    ).toThrow(/plaintext secret detected/i);
  });

  it("does not throw for clean configs", () => {
    expect(() =>
      assertNoPlaintextSecrets({ gateway: { mode: "local", bind: "lan" } })
    ).not.toThrow();
  });

  it("does not throw when every finding is carried over from the previous config", () => {
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };
    const next = { ...previous, update: { checkOnStart: false } };

    expect(() => assertNoPlaintextSecrets(next, () => previous)).not.toThrow();
  });

  it("reports the carried-over leak instead of swallowing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };

    assertNoPlaintextSecrets({ ...previous, update: { checkOnStart: false } }, () => previous);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("env.OLLAMA_CLOUD_API_KEY");
    // The value itself must never reach the logs.
    expect(message).not.toContain(LEGACY_KEY);
  });

  it("reports a carried-over leak once per process, not on every config write", () => {
    // The message is a one-time instruction ("rotate that key and delete the
    // entry"), but config writes are not one-time: boot seeds, every settings
    // save, every agent create. Repeating a four-line paragraph on each of
    // them is how an actionable warning turns into background noise nobody
    // reads. A leak at a NEW path still gets its own report.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };
    const next = { ...previous, update: { checkOnStart: false } };

    assertNoPlaintextSecrets(next, () => previous);
    assertNoPlaintextSecrets(next, () => previous);
    assertNoPlaintextSecrets(next, () => previous);

    expect(warn).toHaveBeenCalledTimes(1);

    const widened = {
      ...previous,
      models: { providers: { "ollama-cloud": { apiKey: LEGACY_KEY } } },
    };
    assertNoPlaintextSecrets(widened, () => widened);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain("models.providers.ollama-cloud.apiKey");
  });

  it("still throws for a newly introduced secret even when another one is carried over", () => {
    const previous = { env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY } };
    const next = {
      env: { OLLAMA_CLOUD_API_KEY: LEGACY_KEY },
      models: { providers: { anthropic: { apiKey: "sk-ant-regression1234567890" } } },
    };

    expect(() => assertNoPlaintextSecrets(next, () => previous)).toThrow(
      /models\.providers\.anthropic\.apiKey/
    );
  });
});
