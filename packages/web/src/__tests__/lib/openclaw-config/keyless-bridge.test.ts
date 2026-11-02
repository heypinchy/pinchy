// openclaw.json stops naming a key before secrets.json loses it.
//
// regenerateOpenClawConfig writes secrets.json from the database, so a deleted
// provider's key leaves it at once. OpenClaw's openclaw.json still names that
// key until the push delivers the deletion — for a large provider a stepped
// hand-over at OpenClaw's rate limit, minutes long, or dropped and resumed.
// Every reader of the file in that window needs its SecretRefs to resolve:
// OpenClaw at (re)start, and every config.apply of a copy of it (a targeted
// writer reads the file and changes one block). And Pinchy cannot read
// secrets.json in production (root:root 0600), so nothing may depend on it.
//
// So regenerate first writes the on-disk config with every provider that names
// a key the new bundle lacks replaced by its key-less stub, keeping its models:
// the "bridge". These are its pure rules; build.ts wiring is covered in
// openclaw-config.test.ts, OpenClaw's acceptance of it in
// integration/openclaw-config-size-drop-against-oc.test.ts.
import { describe, it, expect } from "vitest";
import {
  keylessBridge,
  pinchySecretRefIds,
  unresolvedSecretRefs,
} from "@/lib/openclaw-config/keyless-bridge";

const ref = (id: string) => ({ source: "file", provider: "pinchy", id });

function config(providers: Record<string, unknown>) {
  return {
    meta: { lastTouchedAt: "2026-11-01T00:00:00.000Z" },
    gateway: { mode: "local" },
    secrets: { providers: { pinchy: { source: "file", path: "/x", mode: "json" } } },
    agents: { list: [{ id: "smithers", model: "anthropic/claude-haiku-4-5-20251001" }] },
    models: { providers },
  };
}

const models = Array.from({ length: 40 }, (_, i) => ({
  id: `acme-model-${i}-with-a-realistically-long-identifier`,
  name: `Acme Model ${i}`,
  contextWindow: 128000,
}));
const anthropic = {
  baseUrl: "https://api.anthropic.com",
  api: "anthropic-messages",
  apiKey: ref("/providers/anthropic/apiKey"),
  models: [{ id: "claude-haiku-4-5-20251001" }],
};
const acme = {
  baseUrl: "https://admin:hunter2@acme.example/v1?api-key=QQQ#frag",
  api: "openai-completions",
  apiKey: ref("/providers/acme-llm/apiKey"),
  headers: { "x-acme-token": "plaintext-header-secret" },
  models,
};
const bundleWithoutAcme = { providers: { anthropic: { apiKey: "sk-ant" } } };

describe("pinchySecretRefIds", () => {
  it("collects every pinchy file SecretRef id anywhere in the config", () => {
    const ids = pinchySecretRefIds({
      ...config({ anthropic, acme }),
      channels: { telegram: { accounts: { a1: { botToken: ref("/telegram/a1/botToken") } } } },
      // Not ours: another secrets provider, and an env template.
      other: { apiKey: { source: "env", provider: "default", id: "X" } },
    });
    expect([...ids].sort()).toEqual([
      "/providers/acme-llm/apiKey",
      "/providers/anthropic/apiKey",
      "/telegram/a1/botToken",
    ]);
  });
});

describe("unresolvedSecretRefs", () => {
  it("names every pinchy SecretRef the bundle cannot resolve to a string", () => {
    expect(unresolvedSecretRefs(config({ anthropic, acme }), bundleWithoutAcme)).toEqual([
      "/providers/acme-llm/apiKey",
    ]);
    expect(unresolvedSecretRefs(config({ anthropic }), bundleWithoutAcme)).toEqual([]);
  });

  it("never reads through a pointer that reaches the prototype — it counts as unresolved", () => {
    const bundle = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    expect(unresolvedSecretRefs({ x: ref("/__proto__/polluted") }, bundle)).toEqual([
      "/__proto__/polluted",
    ]);
    expect(unresolvedSecretRefs({ x: ref("not-a-pointer") }, bundle)).toEqual(["not-a-pointer"]);
  });
});

describe("keylessBridge", () => {
  it("is null when every SecretRef in the file resolves — nothing to bridge", () => {
    expect(keylessBridge(config({ anthropic }), bundleWithoutAcme)).toBeNull();
    // A rotation changes the value, never the reference.
    expect(
      keylessBridge(config({ anthropic }), { providers: { anthropic: { apiKey: "sk-ROTATED" } } })
    ).toBeNull();
  });

  it("replaces a provider whose key the bundle lacks with a key-less stub that keeps all its models", () => {
    const onDisk = config({ anthropic, "acme-llm": acme });
    const bridge = keylessBridge(onDisk, bundleWithoutAcme);

    expect(bridge).not.toBeNull();
    const providers = (bridge as { models: { providers: Record<string, unknown> } }).models
      .providers;
    expect(providers["acme-llm"]).toEqual({
      baseUrl: "https://acme.example/v1",
      api: "openai-completions",
      models,
    });
    // Everything else is the file as it was.
    expect(providers.anthropic).toEqual(anthropic);
    expect({ ...bridge, models: undefined }).toEqual({ ...onDisk, models: undefined });
    // The input is not mutated.
    expect(onDisk.models.providers["acme-llm"]).toBe(acme);
  });

  it("leaves no SecretRef the bundle cannot resolve, and no credential of the stubbed provider", () => {
    // A kept provider whose key went away too (its reference cannot stay either).
    const ollama = {
      baseUrl: "http://ollama:11434",
      api: "ollama",
      apiKey: ref("/providers/ollama-local/apiKey"),
      models: [{ id: "qwen3" }],
    };
    const bridge = keylessBridge(
      config({ anthropic, "acme-llm": acme, ollama }),
      bundleWithoutAcme
    );

    expect(unresolvedSecretRefs(bridge, bundleWithoutAcme)).toEqual([]);
    const text = JSON.stringify(bridge);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("QQQ");
    expect(text).not.toContain("plaintext-header-secret");
    expect(
      (bridge as { models: { providers: Record<string, { models: unknown }> } }).models.providers
        .ollama.models
    ).toEqual([{ id: "qwen3" }]);
  });

  it("stays over half of the file it replaces, so neither of OpenClaw's size guards objects", () => {
    // OpenClaw refuses a write under floor(OLD * 0.5) bytes and restores .bak
    // over a file under half of last-known-good. Only key references and
    // credentials leave; the models — most of the file — stay.
    const onDisk = JSON.stringify(config({ anthropic, "acme-llm": acme }), null, 2);
    const bridge = JSON.stringify(keylessBridge(JSON.parse(onDisk), bundleWithoutAcme), null, 2);
    expect(Buffer.byteLength(bridge)).toBeGreaterThan(Buffer.byteLength(onDisk) * 0.9);
  });
});
