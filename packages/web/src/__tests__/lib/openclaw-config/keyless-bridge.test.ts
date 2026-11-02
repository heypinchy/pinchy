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
  rekeyedBridge,
  unresolvedSecretRefs,
} from "@/lib/openclaw-config/keyless-bridge";
import { expectsSizeDropRefusal } from "@/lib/openclaw-config/size-drop";

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

describe("unresolvedSecretRefs", () => {
  it("looks at every pinchy file SecretRef anywhere in the config, and at no other kind", () => {
    const unresolved = unresolvedSecretRefs(
      {
        ...config({ anthropic, acme }),
        channels: { telegram: { accounts: { a1: { botToken: ref("/telegram/a1/botToken") } } } },
        // Not ours: another secrets provider, and an env template.
        other: { apiKey: { source: "env", provider: "default", id: "X" } },
      },
      {}
    );
    expect(unresolved.sort()).toEqual([
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

// A re-keyed OpenAI-compatible provider: its key slot is versioned
// (`<slug>@<version>`), so a new key is a new slot, and the old one leaves the
// bundle while the on-disk file still names it. keylessBridge stubs it like a
// deleted provider; rekeyedBridge — written once secrets.json holds the new
// slot — gives it back, as the TARGET has it.
describe("rekeyedBridge", () => {
  const OLD = "/providers/acme-llm@0000000000000001/apiKey";
  const NEW = "/providers/acme-llm@0000000000000002/apiKey";
  const acmeOld = { ...acme, apiKey: ref(OLD) };
  const acmeTarget = {
    // The key was re-entered for a new address (#1238 requires it).
    baseUrl: "https://new-gateway.example/v1",
    api: "openai-completions",
    apiKey: ref(NEW),
    models: Array.from({ length: 40 }, (_, i) => ({
      id: `acme-next-${i}`,
      name: `Acme Next ${i}`,
    })),
  };
  const rekeyedBundle = {
    providers: {
      anthropic: { apiKey: "sk-ant" },
      "acme-llm@0000000000000002": { apiKey: "sk-acme-new" },
    },
  };

  it("gives a re-keyed provider the target's whole entry: its new slot never meets the old address", () => {
    const onDisk = config({ anthropic, "acme-llm": acmeOld });
    const target = config({ anthropic, "acme-llm": acmeTarget });
    const keyless = keylessBridge(onDisk, rekeyedBundle)!;
    expect(unresolvedSecretRefs(keyless, {}), "the stub resolves against any file").toEqual([
      "/providers/anthropic/apiKey",
    ]);

    const rekeyed = rekeyedBridge(keyless, onDisk, target, rekeyedBundle);

    const providers = (rekeyed as { models: { providers: Record<string, unknown> } }).models
      .providers;
    expect(providers["acme-llm"]).toEqual(acmeTarget);
    expect(providers.anthropic).toEqual(anthropic);
    expect(unresolvedSecretRefs(rekeyed, rekeyedBundle)).toEqual([]);
    // Everything outside the provider is the bridge as it was, not the target.
    expect({ ...rekeyed, models: undefined }).toEqual({ ...keyless, models: undefined });
  });

  it("takes the upgrade from an unversioned slot the same way", () => {
    const onDisk = config({ anthropic, "acme-llm": acme });
    const target = config({ anthropic, "acme-llm": acmeTarget });
    const keyless = keylessBridge(onDisk, rekeyedBundle)!;
    const rekeyed = rekeyedBridge(keyless, onDisk, target, rekeyedBundle);
    expect(
      (rekeyed as { models: { providers: Record<string, unknown> } }).models.providers["acme-llm"]
    ).toEqual(acmeTarget);
  });

  // A bridge can reach OpenClaw's file with no re-keyed entry after it: sent
  // over config.apply, copied back by a targeted writer, or Pinchy stopping
  // between the two writes. The next regenerate finds a file whose every
  // SecretRef resolves — no bridge to write — and must still give the stub
  // its entry: the decision is read off the file.
  it("gives a provider the file already holds as a key-less stub the target's entry", () => {
    const onDisk = keylessBridge(config({ anthropic, "acme-llm": acmeOld }), rekeyedBundle)!;
    const target = config({ anthropic, "acme-llm": acmeTarget });
    expect(keylessBridge(onDisk, rekeyedBundle), "precondition: nothing to bridge").toBeNull();

    const rekeyed = rekeyedBridge(onDisk, onDisk, target, rekeyedBundle);

    expect(
      (rekeyed as { models: { providers: Record<string, unknown> } }).models.providers["acme-llm"]
    ).toEqual(acmeTarget);
    expect({ ...rekeyed, models: undefined }).toEqual({ ...onDisk, models: undefined });
  });

  it("leaves a key-less provider alone when its target entry names no key either", () => {
    const keyless = { baseUrl: "http://ollama:11434", api: "ollama", models };
    const onDisk = config({ anthropic, local: keyless });
    const target = config({ anthropic, local: { ...keyless, models: models.slice(0, 39) } });
    expect(rekeyedBridge(onDisk, onDisk, target, rekeyedBundle)).toBeNull();
  });

  it("is null for a deleted provider — its stub stays until the push removes it", () => {
    const onDisk = config({ anthropic, "acme-llm": acme });
    const keyless = keylessBridge(onDisk, bundleWithoutAcme)!;
    expect(rekeyedBridge(keyless, onDisk, config({ anthropic }), bundleWithoutAcme)).toBeNull();
  });

  // The new address can serve a much smaller catalogue (a large OpenRouter
  // list → a small endpoint). Written whole, the entry would take the file
  // under half of OpenClaw's last-known-good, and OpenClaw's read path would
  // restore `.bak` — its own pre-bridge write, naming the slot secrets.json no
  // longer has: "required secrets are unavailable". So the entry keeps the
  // models the file already lists, after the target's own — only as many as
  // keep the file above that line; the catalogue shrink itself is the guarded
  // push's job.
  it("keeps the file's models in a re-keyed entry whose target catalogue would shrink the file past OpenClaw's read-side check", () => {
    const smallTarget = { ...acmeTarget, models: [{ id: "acme-next" }] };
    const onDisk = config({ anthropic, "acme-llm": acmeOld });
    const target = config({ anthropic, "acme-llm": smallTarget });
    const serialize = (c: unknown) => JSON.stringify(c, null, 2).trimEnd() + "\n";
    expect(
      expectsSizeDropRefusal(serialize(onDisk), serialize(target)),
      "precondition: the target's entry, written whole, would trip OpenClaw's check"
    ).toBe(true);
    const keyless = keylessBridge(onDisk, rekeyedBundle)!;

    const rekeyed = rekeyedBridge(keyless, onDisk, target, rekeyedBundle)!;

    const entry = (rekeyed as { models: { providers: Record<string, unknown> } }).models.providers[
      "acme-llm"
    ];
    const kept = (entry as { models: unknown[] }).models.length - 1;
    expect(entry).toEqual({
      ...smallTarget,
      models: [{ id: "acme-next" }, ...models.slice(0, kept)],
    });
    expect(expectsSizeDropRefusal(serialize(onDisk), serialize(rekeyed))).toBe(false);
    expect(unresolvedSecretRefs(rekeyed, rekeyedBundle)).toEqual([]);
    expect(JSON.stringify(rekeyed)).not.toMatch(/hunter2|QQQ|plaintext-header-secret/);
    // Just above the line: one model fewer and it would be under it.
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(models.length);
    expect(expectsSizeDropRefusal(serialize(onDisk), serialize(withAcmeModels(kept - 1)))).toBe(
      true
    );
    function withAcmeModels(count: number) {
      return {
        ...rekeyed,
        models: {
          providers: {
            ...(rekeyed as { models: { providers: Record<string, unknown> } }).models.providers,
            "acme-llm": {
              ...smallTarget,
              models: [{ id: "acme-next" }, ...models.slice(0, count)],
            },
          },
        },
      };
    }
  });

  // A target just over half of the file passes the #311 guard and is pushed,
  // yet written whole its entry would still sit inside the headroom kept over
  // OpenClaw's read-side line. Carrying EVERY file model then made the file
  // larger than before the re-key: OpenClaw refused the push's target as a
  // size drop against it (no deleted provider to step), and every later
  // regenerate was refused by the #311 guard against the enlarged file — while
  // on main the same apply went through. Only as many file models as keep the
  // file above the line: the target then clears OpenClaw's write-side check
  // against it, and the next regenerate's guard.
  it("never makes the file larger than the push's target can shrink, for a target just over half of it", () => {
    const serialize = (c: unknown) => JSON.stringify(c, null, 2).trimEnd() + "\n";
    const onDisk = config({ anthropic, "acme-llm": acmeOld });
    const onDiskContent = serialize(onDisk);
    const targetWith = (n: number) =>
      config({
        anthropic,
        "acme-llm": {
          ...acmeTarget,
          models: Array.from({ length: n }, (_, i) => ({
            id: `new-model-${i}-with-a-realistically-long-identifier`,
            name: `New Model ${i}`,
            contextWindow: 128000,
          })),
        },
      });
    // Every catalogue size whose target passes the #311 guard (at least half
    // of the file) yet sits inside expectsSizeDropRefusal's headroom.
    const band = Array.from({ length: 40 }, (_, n) => n + 1).filter((n) => {
      const content = serialize(targetWith(n));
      return (
        content.length >= onDiskContent.length * 0.5 &&
        expectsSizeDropRefusal(onDiskContent, content)
      );
    });
    expect(band.length, "precondition: some targets fall in the band").toBeGreaterThan(0);

    for (const n of band) {
      const target = targetWith(n);
      const targetContent = serialize(target);
      const keyless = keylessBridge(onDisk, rekeyedBundle)!;
      const rekeyed = rekeyedBridge(keyless, onDisk, target, rekeyedBundle)!;
      const written = serialize(rekeyed);

      expect(expectsSizeDropRefusal(onDiskContent, written), `n=${n}: above the line`).toBe(false);
      expect(Buffer.byteLength(written), `n=${n}: never larger than before`).toBeLessThan(
        Buffer.byteLength(onDiskContent)
      );
      // OpenClaw's write-side check of the push's target against this file.
      expect(Buffer.byteLength(targetContent), `n=${n}: the push lands`).toBeGreaterThanOrEqual(
        Math.floor(Buffer.byteLength(written) * 0.5)
      );
      // The next regenerate's #311 guard against this file.
      expect(targetContent.length, `n=${n}: not refused next time`).toBeGreaterThanOrEqual(
        written.length * 0.5
      );
    }
  });

  it("keeps the stub when the target's entry would not resolve either", () => {
    const onDisk = config({ anthropic, "acme-llm": acmeOld });
    const target = config({ anthropic, "acme-llm": acmeTarget });
    const keyless = keylessBridge(onDisk, bundleWithoutAcme)!;
    expect(rekeyedBridge(keyless, onDisk, target, bundleWithoutAcme)).toBeNull();
  });
});
