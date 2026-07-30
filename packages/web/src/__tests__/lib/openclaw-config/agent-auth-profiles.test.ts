// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";

// Hoist the real implementations before mocking so we can use them as defaults.
const { realRenameSync, realWriteFileSync, realMkdirSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require("fs") as typeof import("fs");
  return {
    realRenameSync: realFs.renameSync.bind(realFs),
    realWriteFileSync: realFs.writeFileSync.bind(realFs),
    realMkdirSync: realFs.mkdirSync.bind(realFs),
  };
});

// Mock fs so the write path can be intercepted per-test. All other methods call
// through to the real implementation so tmpDir creation and assertions work.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const renameSyncMock = vi.fn(realRenameSync);
  const writeFileSyncMock = vi.fn(realWriteFileSync);
  const mkdirSyncMock = vi.fn(realMkdirSync);
  return {
    ...actual,
    default: {
      ...actual,
      renameSync: renameSyncMock,
      writeFileSync: writeFileSyncMock,
      mkdirSync: mkdirSyncMock,
    },
    renameSync: renameSyncMock,
    writeFileSync: writeFileSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

/** Build the exact error Node raises when the target directory denies uid 999. */
function eaccesError(): NodeJS.ErrnoException {
  const err = new Error("EACCES: permission denied, open 'auth-profiles.json.tmp-100'");
  (err as NodeJS.ErrnoException).code = "EACCES";
  (err as NodeJS.ErrnoException).errno = -13;
  (err as NodeJS.ErrnoException).syscall = "open";
  return err;
}

import * as fs from "fs";
import {
  writeAgentAuthProfiles,
  type WriteAgentAuthProfilesParams,
} from "@/lib/openclaw-config/agent-auth-profiles";

describe("writeAgentAuthProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-test-"));
    vi.mocked(fs.renameSync).mockImplementation(realRenameSync);
    vi.mocked(fs.writeFileSync).mockImplementation(realWriteFileSync);
    vi.mocked(fs.mkdirSync).mockImplementation(realMkdirSync);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  it("writes auth-profiles.json with one profile per configured provider", async () => {
    await writeAgentAuthProfiles({
      configRoot: tmpDir,
      agentId: "agent-123",
      providers: ["anthropic", "openai"],
    });

    const expectedPath = path.join(tmpDir, "agents", "agent-123", "agent", "auth-profiles.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    expect(content.profiles["anthropic-default"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      keyRef: { kind: "secret", path: "providers.anthropic.apiKey" },
    });
    expect(content.profiles["openai-default"]).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { kind: "secret", path: "providers.openai.apiKey" },
    });
  });

  it("writes atomically — no partial files visible at the destination path", async () => {
    // Implementation must call fs.renameSync (namespace form, not destructured) for this spy to work.
    // The plan's Task 3 implementation uses fs.renameSync(...) — that assumption is load-bearing here.
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("rename failed");
    });
    await expect(
      writeAgentAuthProfiles({
        configRoot: tmpDir,
        agentId: "a",
        providers: ["anthropic"],
      })
    ).rejects.toThrow("rename failed");
    const destPath = path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json");
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("is idempotent — writing the same input twice produces identical bytes", async () => {
    // Explicit param type (not `as const`) — `providers` must stay the mutable
    // AuthProfilesProvider[] the function expects, not a readonly tuple.
    const params: WriteAgentAuthProfilesParams = {
      configRoot: tmpDir,
      agentId: "a",
      providers: ["anthropic"],
    };
    await writeAgentAuthProfiles(params);
    const first = fs.readFileSync(path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json"));
    await writeAgentAuthProfiles(params);
    const second = fs.readFileSync(path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json"));
    expect(first.equals(second)).toBe(true);
  });

  it("creates intermediate directories", async () => {
    await writeAgentAuthProfiles({
      configRoot: tmpDir,
      agentId: "nested/deep",
      providers: ["anthropic"],
    });
    const expectedPath = path.join(tmpDir, "agents", "nested/deep", "agent", "auth-profiles.json");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("writes file with mode 0600", async () => {
    await writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: ["anthropic"] });
    const stat = fs.statSync(path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("empty providers — removes existing auth-profiles.json to prevent strict auth mode", async () => {
    const agentDir = path.join(tmpDir, "agents", "a", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const filePath = path.join(agentDir, "auth-profiles.json");
    fs.writeFileSync(filePath, JSON.stringify({ profiles: { "anthropic-default": {} } }));

    await writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: [] });

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("empty providers — no-op when auth-profiles.json does not exist", async () => {
    await expect(
      writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "no-file-agent", providers: [] })
    ).resolves.toBeUndefined();
  });

  // #934: agents/<id>/agent is shared with OpenClaw, which creates it root-owned
  // at mode 0700 when it derives that agent's models.json. start-openclaw.sh's
  // 50 ms tick chowns it back to uid 999, but a write landing INSIDE that window
  // still gets EACCES. Same shape (and same budget) as readExistingConfig's
  // 5 × 100 ms retry, which is what the 50 ms tick was tuned against.
  describe("EACCES retry — rides out the permission-repair tick", () => {
    it("retries a denied write and succeeds once the tick lands", async () => {
      vi.mocked(fs.writeFileSync)
        .mockImplementationOnce(() => {
          throw eaccesError();
        })
        .mockImplementationOnce(() => {
          throw eaccesError();
        });

      await writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: ["openai"] });

      const target = path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json");
      expect(fs.existsSync(target)).toBe(true);
      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(3);
    });

    it("retries a denied mkdir too — agents/<id> can be root-owned as well", async () => {
      vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
        throw eaccesError();
      });

      await writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: ["openai"] });

      expect(fs.existsSync(path.join(tmpDir, "agents", "a", "agent", "auth-profiles.json"))).toBe(
        true
      );
    });

    it("gives up after a bounded budget and rethrows, rather than hanging the regenerate", async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw eaccesError();
      });

      await expect(
        writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: ["openai"] })
      ).rejects.toThrow(/EACCES/);
      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(5);
    });

    it("does not retry an error the tick cannot fix", async () => {
      const enospc = new Error("ENOSPC: no space left on device");
      (enospc as NodeJS.ErrnoException).code = "ENOSPC";
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw enospc;
      });

      await expect(
        writeAgentAuthProfiles({ configRoot: tmpDir, agentId: "a", providers: ["openai"] })
      ).rejects.toThrow(/ENOSPC/);
      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(1);
    });
  });
});
