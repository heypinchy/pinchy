// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";

// Hoist the real renameSync before mocking so we can use it as the default implementation.
const { realRenameSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require("fs") as typeof import("fs");
  return { realRenameSync: realFs.renameSync.bind(realFs) };
});

// Mock fs so renameSync can be intercepted per-test. All other methods call
// through to the real implementation so tmpDir creation and assertions work.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const renameSyncMock = vi.fn(realRenameSync);
  return {
    ...actual,
    default: { ...actual, renameSync: renameSyncMock },
    renameSync: renameSyncMock,
  };
});

import * as fs from "fs";
import { writeAgentAuthProfiles } from "@/lib/openclaw-config/agent-auth-profiles";

describe("writeAgentAuthProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-test-"));
    vi.mocked(fs.renameSync).mockImplementation(realRenameSync);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(fs.renameSync).mockReset();
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
    const params = { configRoot: tmpDir, agentId: "a", providers: ["anthropic"] as const };
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
});
