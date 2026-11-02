import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  secretRef,
  writeSecretsFile,
  readSecretsFile,
  checkSecretsVolumeWritable,
  secretVersion,
  versionedSecretName,
  referencedSecretIds,
} from "@/lib/openclaw-secrets";
import { readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("secretRef", () => {
  it("builds a SecretRef pointing at the pinchy file provider", () => {
    expect(secretRef("/providers/anthropic/apiKey")).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
  });
});

describe("referencedSecretIds", () => {
  it("collects every pinchy file SecretRef id anywhere in a config", () => {
    const config = {
      models: {
        providers: {
          anthropic: { apiKey: secretRef("/providers/anthropic/apiKey") },
          acme: {
            baseUrl: "https://acme.example/v1",
            apiKey: secretRef("/providers/acme@0123456789abcdef/apiKey"),
          },
        },
      },
      channels: { list: [{ token: secretRef("/telegram/bot-1/botToken") }] },
      // Not ours: another provider's ref, and a lookalike plain string.
      other: { source: "env", provider: "default", id: "/providers/x/apiKey" },
      note: "/providers/y/apiKey",
    };
    expect(referencedSecretIds(config)).toEqual(
      new Set([
        "/providers/anthropic/apiKey",
        "/providers/acme@0123456789abcdef/apiKey",
        "/telegram/bot-1/botToken",
      ])
    );
  });

  it("is empty for an empty or missing config", () => {
    expect(referencedSecretIds({})).toEqual(new Set());
    expect(referencedSecretIds(undefined)).toEqual(new Set());
  });
});

describe("secretVersion / versionedSecretName", () => {
  it("derives a short, stable hex version that differs for different material", () => {
    expect(secretVersion("ciphertext-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(secretVersion("ciphertext-1")).toBe(secretVersion("ciphertext-1"));
    expect(secretVersion("ciphertext-1")).not.toBe(secretVersion("ciphertext-2"));
  });

  it("names a versioned slot `<name>@<version>`", () => {
    expect(versionedSecretName("acme-llm", "0123456789abcdef")).toBe("acme-llm@0123456789abcdef");
  });
});

describe("writeSecretsFile", () => {
  let dir: string;
  const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("writes JSON to OPENCLAW_SECRETS_PATH", () => {
    writeSecretsFile(bundle);
    const content = readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8");
    expect(JSON.parse(content)).toEqual(bundle);
  });

  it("creates the file with mode 0600 (owner read/write only)", () => {
    writeSecretsFile(bundle);
    const mode = statSync(process.env.OPENCLAW_SECRETS_PATH!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("overwrites an existing file completely", () => {
    writeSecretsFile(bundle);
    // Overwrite — there must never be a window where the file is empty/truncated.
    writeSecretsFile({ providers: { openai: { apiKey: "sk-new" } } });
    expect(existsSync(process.env.OPENCLAW_SECRETS_PATH!)).toBe(true);
    const content = JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));
    expect(content.providers.openai.apiKey).toBe("sk-new");
  });

  it("uses atomic rename pattern (no .tmp file left behind)", () => {
    writeSecretsFile(bundle);
    expect(existsSync(`${process.env.OPENCLAW_SECRETS_PATH!}.tmp`)).toBe(false);
  });

  it("does not rewrite the file when content is unchanged (inode preserved)", () => {
    // Without this, every regenerateOpenClawConfig() bumps secrets.json's
    // mtime, and the inotify watcher in start-openclaw.sh would uselessly
    // restart the OpenClaw gateway on every Pinchy startup. We check the
    // inode rather than mtime so we don't depend on filesystem mtime
    // granularity (or wall-clock waits) to detect a rewrite — the atomic
    // rename pattern always allocates a new inode when it does write.
    writeSecretsFile(bundle);
    const path = process.env.OPENCLAW_SECRETS_PATH!;
    const inoBefore = statSync(path).ino;
    writeSecretsFile(bundle);
    const inoAfter = statSync(path).ino;
    expect(inoAfter).toBe(inoBefore);
  });

  it("does rewrite the file when content changes", () => {
    writeSecretsFile(bundle);
    writeSecretsFile({ providers: { openai: { apiKey: "sk-different" } } });
    const content = JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));
    expect(content.providers.openai.apiKey).toBe("sk-different");
  });

  // The return value is the only signal a caller has that the running OpenClaw
  // now holds a stale credential. A rotation on an ALREADY-configured provider
  // changes nothing but this file — the emitted openclaw.json carries a
  // SecretRef, not the value — so every config-level change detector reports
  // "nothing happened" and the new key never reaches the runtime (#943).
  it("reports a stale runtime when it creates the file", () => {
    expect(writeSecretsFile(bundle)).toBe(true);
  });

  it("reports a stale runtime when the key is rotated", () => {
    writeSecretsFile(bundle);
    expect(writeSecretsFile({ providers: { anthropic: { apiKey: "sk-ant-rotated" } } })).toBe(true);
  });

  it("reports nothing to do when the bundle is identical", () => {
    writeSecretsFile(bundle);
    expect(writeSecretsFile(bundle)).toBe(false);
  });

  // A removal is the one secrets change that must NOT report a stale runtime.
  // OpenClaw re-resolves the config it is CURRENTLY running, and that config
  // still points at the key we just took away — so the reload fails on the
  // dangling pointer, OpenClaw marks its secrets runtime degraded, and the
  // operator is told to restart a gateway that the config apply from this very
  // regenerate is already about to repair. The removal travels with that config
  // change; it needs no reload of its own.
  it("reports nothing to do when a provider is only removed", () => {
    writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "b" } } });
    expect(writeSecretsFile({ providers: { anthropic: { apiKey: "a" } } })).toBe(false);
  });

  it("still writes the removal to disk even though it reports nothing to do", () => {
    writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "b" } } });
    writeSecretsFile({ providers: { anthropic: { apiKey: "a" } } });
    const content = JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));
    expect(content.providers.openai).toBeUndefined();
  });

  it("reports a stale runtime when one key rotates while another is removed", () => {
    // Mixed change: the rotation still has to reach the runtime, so the
    // removal-only exemption must not swallow it.
    writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "b" } } });
    expect(writeSecretsFile({ providers: { anthropic: { apiKey: "rotated" } } })).toBe(true);
  });

  // A versioned slot (`<name>@<version>`) changes its NAME whenever its value
  // changes, so the config that points at it changes too — and the config apply
  // re-resolves config-tree SecretRefs from this file. A reload here would only
  // re-resolve the config OpenClaw is still running, whose pointer this write
  // just removed: it would fail closed and log a degraded runtime for nothing.
  describe("versioned secrets (a new value is a new pointer)", () => {
    const v1 = versionedSecretName("acme-llm", secretVersion("ciphertext-1"));
    const v2 = versionedSecretName("acme-llm", secretVersion("ciphertext-2"));

    it("reports nothing to do when a versioned slot is replaced by a new version", () => {
      writeSecretsFile({ providers: { [v1]: { apiKey: "old-key" } } });
      expect(writeSecretsFile({ providers: { [v2]: { apiKey: "new-key" } } })).toBe(false);
    });

    it("reports nothing to do on the upgrade from an unversioned slot to a versioned one", () => {
      writeSecretsFile({ providers: { "acme-llm": { apiKey: "key" } } });
      expect(writeSecretsFile({ providers: { [v1]: { apiKey: "key" } } })).toBe(false);
    });

    it("still reports a stale runtime when an unversioned key rotates in the same write", () => {
      writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, [v1]: { apiKey: "k" } } });
      expect(
        writeSecretsFile({
          providers: { anthropic: { apiKey: "rotated" }, [v2]: { apiKey: "k2" } },
        })
      ).toBe(true);
    });
  });

  // OpenClaw moves off a superseded pointer only when the config that names the
  // new one is applied — and that apply runs in the background, 60–100 s late
  // under rate limiting or a restart. Until then the RUNNING config points at
  // the old slot, and a `secrets.reload` (fired by a built-in key rotation in
  // that window) re-resolves exactly that config. Removing the old slot the
  // moment it is superseded makes that reload fail, and the rotated built-in
  // key never reaches the runtime. So a value the running config still points
  // at stays — an old pointer next to its old value is still a consistent
  // pair — and goes with the first write after the running config moved on.
  describe("values the running config still points at", () => {
    const v1 = versionedSecretName("acme-llm", secretVersion("ciphertext-1"));
    const v2 = versionedSecretName("acme-llm", secretVersion("ciphertext-2"));
    const ref = (slot: string) => `/providers/${slot}/apiKey`;
    const onDisk = () => JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));

    it("keeps a superseded slot while the running config still points at it", () => {
      writeSecretsFile({ providers: { [v1]: { apiKey: "old-key" } } });
      writeSecretsFile(
        { providers: { [v2]: { apiKey: "new-key" } } },
        { stillReferenced: new Set([ref(v1)]) }
      );
      expect(onDisk().providers).toEqual({
        [v1]: { apiKey: "old-key" },
        [v2]: { apiKey: "new-key" },
      });
    });

    it("drops it with the first write after the running config moved on", () => {
      writeSecretsFile({ providers: { [v1]: { apiKey: "old-key" } } });
      writeSecretsFile(
        { providers: { [v2]: { apiKey: "new-key" } } },
        { stillReferenced: new Set([ref(v1)]) }
      );
      writeSecretsFile(
        { providers: { [v2]: { apiKey: "new-key" } } },
        { stillReferenced: new Set([ref(v2)]) }
      );
      expect(onDisk().providers).toEqual({ [v2]: { apiKey: "new-key" } });
    });

    it("lets a deleted provider's key go once the running config no longer names it", () => {
      writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, [v1]: { apiKey: "k" } } });
      writeSecretsFile(
        { providers: { anthropic: { apiKey: "a" } } },
        { stillReferenced: new Set([ref(v1), ref("anthropic")]) }
      );
      expect(onDisk().providers[v1]).toEqual({ apiKey: "k" });

      writeSecretsFile(
        { providers: { anthropic: { apiKey: "a" } } },
        { stillReferenced: new Set([ref("anthropic")]) }
      );
      expect(onDisk().providers[v1]).toBeUndefined();
    });

    it("keeps the unversioned slot a pre-versioning config still points at", () => {
      // The upgrade case: the running config still names `acme-llm` while the
      // first versioned config is on its way.
      writeSecretsFile({ providers: { "acme-llm": { apiKey: "key" } } });
      writeSecretsFile(
        { providers: { [v1]: { apiKey: "key" } } },
        { stillReferenced: new Set([ref("acme-llm")]) }
      );
      expect(onDisk().providers["acme-llm"]).toEqual({ apiKey: "key" });
    });

    it("never invents a value the previous file did not hold", () => {
      writeSecretsFile(
        { providers: { [v2]: { apiKey: "new-key" } } },
        { stillReferenced: new Set([ref(v1)]) }
      );
      expect(onDisk().providers).toEqual({ [v2]: { apiKey: "new-key" } });
    });

    it("keeping an old value is not a rotation — no reload for it", () => {
      writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, [v1]: { apiKey: "k" } } });
      expect(
        writeSecretsFile(
          { providers: { anthropic: { apiKey: "a" }, [v2]: { apiKey: "k2" } } },
          { stillReferenced: new Set([ref(v1)]) }
        )
      ).toBe(false);
      // …and a later write that only lets it go is a pure removal.
      expect(
        writeSecretsFile(
          { providers: { anthropic: { apiKey: "a" }, [v2]: { apiKey: "k2" } } },
          { stillReferenced: new Set([ref(v2)]) }
        )
      ).toBe(false);
    });

    it("a built-in rotation while an old slot is kept still asks for a reload", () => {
      writeSecretsFile({ providers: { anthropic: { apiKey: "a" }, [v1]: { apiKey: "k" } } });
      writeSecretsFile(
        { providers: { anthropic: { apiKey: "a" }, [v2]: { apiKey: "k2" } } },
        { stillReferenced: new Set([ref(v1)]) }
      );
      expect(
        writeSecretsFile(
          { providers: { anthropic: { apiKey: "rotated" }, [v2]: { apiKey: "k2" } } },
          { stillReferenced: new Set([ref(v1)]) }
        )
      ).toBe(true);
      expect(onDisk().providers[v1]).toEqual({ apiKey: "k" });
    });
  });

  it("reports a stale runtime for a nested plugin secret, not just providers", () => {
    // The bundle is nested (gateway / providers / integrations / telegram /
    // plugins), so the comparison has to walk it rather than eyeball one branch.
    writeSecretsFile({ plugins: { "pinchy-odoo": { refTokenKey: "k1" } } });
    expect(writeSecretsFile({ plugins: { "pinchy-odoo": { refTokenKey: "k2" } } })).toBe(true);
  });

  it("throws an actionable error when the secrets directory cannot be created (missing volume mount)", () => {
    // Reproduce the #878 failure shape: the `openclaw-secrets` volume is not
    // mounted, so the directory Pinchy expects to write into cannot be created.
    // We simulate an un-creatable directory by pointing the path *under a
    // regular file* — mkdir of a directory whose parent component is a file
    // fails the same way an EACCES at the container root does. The bare fs
    // error (EACCES/ENOTDIR) must be replaced by a message that tells the
    // operator their docker-compose.yml is missing the volume.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.OPENCLAW_SECRETS_PATH = join(blocker, "secrets.json");

    expect(() => writeSecretsFile(bundle)).toThrow(/docker-compose\.yml/);
    expect(() => writeSecretsFile(bundle)).toThrow(/openclaw-secrets/);
  });
});

describe("checkSecretsVolumeWritable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("returns ok when the secrets directory is writable", () => {
    expect(checkSecretsVolumeWritable()).toEqual({ ok: true });
  });

  it("returns not-ok with an actionable message when the directory cannot be created", () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.OPENCLAW_SECRETS_PATH = join(blocker, "secrets.json");

    const result = checkSecretsVolumeWritable();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-ok");
    expect(result.message).toMatch(/docker-compose\.yml/);
    expect(result.message).toMatch(/openclaw-secrets/);
  });
});

describe("readSecretsFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("returns empty object when file does not exist", () => {
    const result = readSecretsFile();
    expect(result).toEqual({});
  });

  it("returns parsed JSON when file exists", () => {
    const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
    writeSecretsFile(bundle);
    const result = readSecretsFile();
    expect(result).toEqual(bundle);
  });
});
