import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
  const chmodSyncMock = vi.fn();
  const rmSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      renameSync: renameSyncMock,
      chmodSync: chmodSyncMock,
      rmSync: rmSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    chmodSync: chmodSyncMock,
    rmSync: rmSyncMock,
  };
});

// OpenAI-compatible custom providers (#894) are DB-backed and now queried
// during config regeneration. The shared @/db mock here returns agent rows
// for every table, so stub this module to an empty list to keep the test hermetic.
vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
  listProvidersWithApiKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingsByPrefix: vi.fn().mockResolvedValue(new Map()),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
  return {
    ...actual,
    writeSecretsFile: vi.fn(),
    readSecretsFile: vi.fn().mockReturnValue({}),
  };
});

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn(async () => ""),
}));

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedDb = vi.mocked(db);

function mockAgents(agentsData: unknown[]) {
  mockedDb.select.mockReturnValue({
    from: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(agentsData), {
        innerJoin: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            where: vi.fn().mockResolvedValue([]),
          })
        ),
        where: vi.fn().mockResolvedValue([]),
      })
    ),
  } as never);
}

describe("regenerateOpenClawConfig — skills emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: unknown) => {
      // openclaw.json read — return a valid base config
      if (typeof path === "string" && path.endsWith(".json")) {
        return JSON.stringify({
          gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
        });
      }
      // SKILL.md read by getSkillBody — return a minimal valid frontmatter
      // body that matches what the on-disk web-search SKILL.md looks like.
      if (typeof path === "string" && path.endsWith("/SKILL.md")) {
        const match = path.match(/\/skills\/([^/]+)\/SKILL\.md$/);
        const skillId = match ? match[1] : "unknown";
        return `---\nname: ${skillId}\ndescription: Test skill body for ${skillId}.\n---\n\n# Body\n`;
      }
      // Any other file (bootstrap files for size measurement) — pretend missing
      throw new Error("ENOENT");
    });
  });

  it("emits agents.entries.<id>.skills as an explicit (possibly empty) allowlist for every agent", async () => {
    // The empty allowlist is intentional and verified by smoke-test:
    // skills: [] excludes all 58 bundled OC desktop skills (1password,
    // apple-notes, etc.). Pinchy must always emit the field so bundled
    // skills don't leak into agents we never opted into.
    mockAgents([
      {
        id: "no-skills-agent",
        name: "Plain",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        skills: [],
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    // SKILL.md writes happen during the agentsList map; the openclaw.json
    // atomic write happens at the very end via tmp + renameSync, so the
    // config write's path ends in `.json.tmp`.
    const configCall = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".json.tmp")
    );
    const written = configCall?.[1] as string;
    const config = JSON.parse(written);
    const agent = config.agents.entries["no-skills-agent"];

    expect(agent).toBeDefined();
    expect(agent.skills).toEqual([]);
  });

  it("emits the agent's configured skills verbatim", async () => {
    mockAgents([
      {
        id: "web-agent",
        name: "Web",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
        skills: ["web-search"],
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    // SKILL.md writes happen during the agentsList map; the openclaw.json
    // atomic write happens at the very end via tmp + renameSync, so the
    // config write's path ends in `.json.tmp`.
    const configCall = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".json.tmp")
    );
    const written = configCall?.[1] as string;
    const config = JSON.parse(written);
    const agent = config.agents.entries["web-agent"];

    expect(agent.skills).toEqual(["web-search"]);
  });

  it("treats a missing/null skills column as an empty allowlist (back-compat for pre-migration agents)", async () => {
    mockAgents([
      {
        id: "legacy-agent",
        name: "Legacy",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        // skills column may be null on agents created before the migration
        skills: null,
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    // SKILL.md writes happen during the agentsList map; the openclaw.json
    // atomic write happens at the very end via tmp + renameSync, so the
    // config write's path ends in `.json.tmp`.
    const configCall = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".json.tmp")
    );
    const written = configCall?.[1] as string;
    const config = JSON.parse(written);
    const agent = config.agents.entries["legacy-agent"];

    // Empty allowlist — bundled desktop skills are NOT a sensible default
    // for legacy enterprise agents either.
    expect(agent.skills).toEqual([]);
  });

  it("writes SKILL.md files for every skill in the agent's allowlist", async () => {
    mockAgents([
      {
        id: "web-agent",
        name: "Web",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
        skills: ["web-search"],
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    // Find the SKILL.md write among all writeFileSync calls
    const skillWrites = mockedWriteFileSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].endsWith("/skills/web-search/SKILL.md")
    );
    expect(skillWrites.length).toBeGreaterThanOrEqual(1);

    const skillPath = skillWrites[0][0] as string;
    const skillBody = skillWrites[0][1] as string;
    expect(skillPath).toMatch(/\/workspaces\/web-agent\/skills\/web-search\/SKILL\.md$/);
    expect(skillBody).toContain("name: web-search");
  });

  it("does NOT write SKILL.md files for skills not in the agent's allowlist", async () => {
    mockAgents([
      {
        id: "no-skills-agent",
        name: "Plain",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        skills: [],
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    const skillWrites = mockedWriteFileSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/skills/")
    );
    expect(skillWrites).toEqual([]);
  });

  it("rejects an unknown skill id (drift guard at config-build time)", async () => {
    mockAgents([
      {
        id: "broken-agent",
        name: "Broken",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        skills: ["nonexistent-skill"],
        createdAt: new Date(),
      },
    ]);

    await expect(regenerateOpenClawConfig()).rejects.toThrow(/unknown skill/i);
  });

  describe("skill index for pinchy-files", () => {
    // OpenClaw 2026.9 renders its skills section only when the built-in `read`
    // tool is visible, and every Pinchy agent has `read` denied. pinchy-files
    // lists the skills instead (skills-prompt.ts) and loads a body with
    // pinchy_read, so it needs the index and read access to the skills dir.
    async function filesConfigFor(agent: Record<string, unknown>) {
      mockAgents([
        {
          name: "A",
          model: "anthropic/claude-haiku-4-5-20251001",
          createdAt: new Date(),
          ...agent,
        },
      ]);
      await regenerateOpenClawConfig();
      const configCall = mockedWriteFileSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".json.tmp")
      );
      const config = JSON.parse(configCall?.[1] as string);
      return config.plugins.entries["pinchy-files"].config.agents[agent.id as string];
    }

    it("hands pinchy-files each skill's name, description and SKILL.md location", async () => {
      const files = await filesConfigFor({
        id: "web-agent",
        allowedTools: ["pinchy_web_search"],
        skills: ["web-search"],
      });
      expect(files.skills).toEqual([
        {
          name: "web-search",
          description: "Test skill body for web-search.",
          location: "/root/.openclaw/workspaces/web-agent/skills/web-search/SKILL.md",
        },
      ]);
    });

    it("grants the skills directory read-only, so pinchy_read can load a body", async () => {
      const files = await filesConfigFor({
        id: "web-agent",
        allowedTools: ["pinchy_write", "pinchy_memory"],
        skills: ["web-search"],
      });
      const skillsDir = "/root/.openclaw/workspaces/web-agent/skills";
      expect(files.allowed_paths).toContain(skillsDir);
      expect(files.write_paths).not.toContain(skillsDir);
    });

    it("emits neither the index nor the directory for an agent without skills", async () => {
      const files = await filesConfigFor({ id: "plain-agent", allowedTools: [], skills: [] });
      expect(files.skills).toBeUndefined();
      expect(files.allowed_paths).not.toContain("/root/.openclaw/workspaces/plain-agent/skills");
    });
  });
});
