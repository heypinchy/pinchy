import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeAgentAuthProfiles } from "@/lib/openclaw-config/agent-auth-profiles";

describe("writeAgentAuthProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      throw new Error("rename failed");
    };
    try {
      await expect(
        writeAgentAuthProfiles({
          configRoot: tmpDir,
          agentId: "a",
          providers: ["anthropic"],
        })
      ).rejects.toThrow("rename failed");
    } finally {
      fs.renameSync = originalRename;
    }
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
