// A secret leaves secrets.json only once OpenClaw no longer needs it.
//
// regenerateOpenClawConfig writes secrets.json BEFORE it pushes the config, and
// the push of a provider deletion can take minutes (OpenClaw's 50% size-drop
// rule makes it a stepped hand-over at OpenClaw's rate limit) or be dropped
// and resumed. For that whole window OpenClaw's openclaw.json — on disk and
// live — still points at the deleted provider's key. Taking the key out of
// secrets.json first left a window in which:
//
//   - every config.apply of a config still naming the provider is refused
//     (`active SecretRef resolution failed`), so a targeted writer that reads
//     the file and changes one block (updateTelegramChannelConfig) is refused,
//     and after its retries used to write that same file directly: a file
//     OpenClaw cannot activate;
//   - an OpenClaw restart (the secrets volume survives it) fails at startup
//     with "required secrets are unavailable", and nothing recovers it.
//
// So a secret the next config stops referencing is RETAINED while the on-disk
// openclaw.json still references it, and RELEASED once a config that does not
// reference it has reached OpenClaw — at the latest by the next regenerate
// that finds no reference on disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  pinchySecretRefIds,
  retainSecretsStillReferenced,
  unresolvedSecretRefs,
  setRetainedSecrets,
  releaseRetainedSecrets,
  _resetRetainedSecrets,
} from "@/lib/openclaw-config/secret-retention";

const ref = (id: string) => ({ source: "file", provider: "pinchy", id });

function config(providers: Record<string, unknown>) {
  return {
    secrets: { providers: { pinchy: { source: "file", path: "/x", mode: "json" } } },
    models: { providers },
  };
}

const anthropic = { baseUrl: "https://a", apiKey: ref("/providers/anthropic/apiKey"), models: [] };
const acme = { baseUrl: "https://acme", apiKey: ref("/providers/acme-llm/apiKey"), models: [] };

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

describe("retainSecretsStillReferenced", () => {
  const previous = {
    providers: { anthropic: { apiKey: "sk-ant" }, "acme-llm": { apiKey: "sk-acme" } },
  };
  const next = { providers: { anthropic: { apiKey: "sk-ant" } } };

  it("keeps a removed provider's key while the on-disk config still references it", () => {
    const { bundle, retained } = retainSecretsStillReferenced({
      next,
      previous,
      onDiskConfig: config({ anthropic, acme }),
      nextConfig: config({ anthropic }),
    });
    expect(bundle.providers).toEqual({
      anthropic: { apiKey: "sk-ant" },
      "acme-llm": { apiKey: "sk-acme" },
    });
    expect([...retained.keys()]).toEqual(["/providers/acme-llm/apiKey"]);
    // The authoritative bundle is not mutated.
    expect(next.providers).not.toHaveProperty("acme-llm");
  });

  it("drops it once the on-disk config no longer references it (e.g. a credential-free stub)", () => {
    const stub = {
      baseUrl: "https://removed-provider.invalid/v1",
      api: "openai-completions",
      models: [],
    };
    const { bundle, retained } = retainSecretsStillReferenced({
      next,
      previous,
      onDiskConfig: config({ anthropic, "acme-llm": stub }),
      nextConfig: config({ anthropic }),
    });
    expect(bundle).toEqual(next);
    expect(retained.size).toBe(0);
  });

  it("never overrides a value the next bundle carries (a rotation still wins)", () => {
    const { bundle, retained } = retainSecretsStillReferenced({
      next: { providers: { anthropic: { apiKey: "sk-ant-ROTATED" } } },
      previous,
      onDiskConfig: config({ anthropic }),
      nextConfig: config({ anthropic }),
    });
    expect(bundle.providers?.anthropic?.apiKey).toBe("sk-ant-ROTATED");
    expect(retained.size).toBe(0);
  });

  it("does not paper over a key the NEXT config still references but the bundle lacks", () => {
    // Not a removal: the next config wants the key and has none. Keeping the old
    // one would hide that; OpenClaw's refusal is the honest signal.
    const { bundle, retained } = retainSecretsStillReferenced({
      next: { providers: {} },
      previous,
      onDiskConfig: config({ anthropic }),
      nextConfig: config({ anthropic }),
    });
    expect(bundle).toEqual({ providers: {} });
    expect(retained.size).toBe(0);
  });

  it("ignores pointers that try to reach the prototype", () => {
    const { bundle, retained } = retainSecretsStillReferenced({
      next: {},
      previous: JSON.parse('{"__proto__":{"polluted":"yes"}}'),
      onDiskConfig: { x: ref("/__proto__/polluted") },
      nextConfig: {},
    });
    expect(retained.size).toBe(0);
    expect(bundle).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("unresolvedSecretRefs", () => {
  it("names every pinchy SecretRef the bundle cannot resolve to a string", () => {
    expect(
      unresolvedSecretRefs(config({ anthropic, acme }), {
        providers: { anthropic: { apiKey: "sk-ant" } },
      })
    ).toEqual(["/providers/acme-llm/apiKey"]);
    expect(
      unresolvedSecretRefs(config({ anthropic }), { providers: { anthropic: { apiKey: "x" } } })
    ).toEqual([]);
  });
});

describe("releaseRetainedSecrets", () => {
  let dir: string;
  let secretsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secret-retention-"));
    secretsPath = join(dir, "secrets.json");
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    _resetRetainedSecrets();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SECRETS_PATH;
    rmSync(dir, { recursive: true, force: true });
    _resetRetainedSecrets();
    vi.restoreAllMocks();
  });

  const onDisk = () => JSON.parse(readFileSync(secretsPath, "utf-8"));

  function seed() {
    writeFileSync(
      secretsPath,
      JSON.stringify({
        providers: { anthropic: { apiKey: "sk-ant" }, "acme-llm": { apiKey: "sk-acme" } },
      }),
      { mode: 0o600 }
    );
    setRetainedSecrets(new Map([["/providers/acme-llm/apiKey", "sk-acme"]]));
  }

  it("removes a retained key once a delivered config no longer references it", () => {
    seed();
    vi.spyOn(console, "log").mockImplementation(() => {});
    releaseRetainedSecrets(JSON.stringify(config({ anthropic })));
    expect(onDisk()).toEqual({ providers: { anthropic: { apiKey: "sk-ant" } } });
  });

  it("keeps it while the delivered config still references it (a targeted write of the old file)", () => {
    seed();
    releaseRetainedSecrets(JSON.stringify(config({ anthropic, acme })));
    expect(onDisk().providers["acme-llm"]).toEqual({ apiKey: "sk-acme" });
  });

  it("leaves a value alone that changed since it was retained (re-added with a new key)", () => {
    seed();
    writeFileSync(
      secretsPath,
      JSON.stringify({
        providers: { anthropic: { apiKey: "sk-ant" }, "acme-llm": { apiKey: "sk-acme-NEW" } },
      }),
      { mode: 0o600 }
    );
    releaseRetainedSecrets(JSON.stringify(config({ anthropic })));
    expect(onDisk().providers["acme-llm"]).toEqual({ apiKey: "sk-acme-NEW" });
  });

  it("does nothing when nothing is retained", () => {
    seed();
    _resetRetainedSecrets();
    releaseRetainedSecrets(JSON.stringify(config({ anthropic })));
    expect(onDisk().providers["acme-llm"]).toEqual({ apiKey: "sk-acme" });
  });
});
