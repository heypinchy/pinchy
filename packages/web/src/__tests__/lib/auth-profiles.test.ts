import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeAuthProfiles } from "@/lib/auth-profiles";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "auth-profiles-"));
  process.env.OPENCLAW_DATA_PATH = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_DATA_PATH;
});

describe("writeAuthProfiles", () => {
  it("writes openai-codex profile when subscription is provided", () => {
    writeAuthProfiles({
      openaiCodex: {
        access: "at",
        refresh: "rt",
        expires: 1773854841781,
        accountId: "acc-1",
      },
    });
    const contents = JSON.parse(readFileSync(join(tmpDir, "auth-profiles.json"), "utf-8"));
    expect(contents).toEqual({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "at",
          refresh: "rt",
          expires: 1773854841781,
          accountId: "acc-1",
        },
      },
    });
  });

  it("deletes the profile file when no subscription is active", () => {
    writeAuthProfiles({ openaiCodex: { access: "a", refresh: "r", expires: 1, accountId: "x" } });
    expect(existsSync(join(tmpDir, "auth-profiles.json"))).toBe(true);
    writeAuthProfiles({ openaiCodex: null });
    expect(existsSync(join(tmpDir, "auth-profiles.json"))).toBe(false);
  });

  it("is a no-op when file is absent and nothing to write", () => {
    writeAuthProfiles({ openaiCodex: null });
    expect(existsSync(join(tmpDir, "auth-profiles.json"))).toBe(false);
  });

  it("does not rewrite the file when content is unchanged (prevents hot-reload loops)", () => {
    writeAuthProfiles({ openaiCodex: { access: "a", refresh: "r", expires: 1, accountId: "x" } });
    const content1 = readFileSync(join(tmpDir, "auth-profiles.json"), "utf-8");
    writeAuthProfiles({ openaiCodex: { access: "a", refresh: "r", expires: 1, accountId: "x" } });
    const content2 = readFileSync(join(tmpDir, "auth-profiles.json"), "utf-8");
    expect(content1).toEqual(content2);
  });
});
