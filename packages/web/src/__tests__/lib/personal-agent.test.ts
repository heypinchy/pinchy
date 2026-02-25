import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/db ────────────────────────────────────────────────────────────────
const returningMock = vi.fn();
const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

// ── Mock @/lib/workspace ─────────────────────────────────────────────────────
vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

// ── Mock @/lib/settings ──────────────────────────────────────────────────────
const getSettingMock = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

// ── Mock @/lib/smithers-soul ────────────────────────────────────────────────
vi.mock("@/lib/smithers-soul", () => ({
  SMITHERS_SOUL_MD: "# Smithers\n\nTest soul content",
}));

// ── Mock @/lib/personality-presets ────────────────────────────────────────────
vi.mock("@/lib/personality-presets", () => ({
  PERSONALITY_PRESETS: {
    "the-butler": {
      id: "the-butler",
      greetingMessage: "Good day. I'm {name}. How may I be of assistance?",
    },
  },
  resolveGreetingMessage: (greeting: string | null, name: string) =>
    greeting ? greeting.replace("{name}", name) : null,
}));

// ── Mock @/lib/providers ─────────────────────────────────────────────────────
vi.mock("@/lib/providers", () => ({
  PROVIDERS: {
    anthropic: {
      name: "Anthropic",
      settingsKey: "anthropic_api_key",
      envVar: "ANTHROPIC_API_KEY",
      defaultModel: "anthropic/claude-haiku-4-5-20251001",
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      settingsKey: "openai_api_key",
      envVar: "OPENAI_API_KEY",
      defaultModel: "openai/gpt-4o-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      settingsKey: "google_api_key",
      envVar: "GOOGLE_API_KEY",
      defaultModel: "google/gemini-2.0-flash",
      placeholder: "AIza...",
    },
  },
}));

import { ensureWorkspace, writeWorkspaceFile, writeIdentityFile } from "@/lib/workspace";

describe("createSmithersAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an agent with the given model, ownerId, and isPersonal", async () => {
    const fakeAgent = {
      id: "agent-shared-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    const agent = await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
    });

    expect(valuesMock).toHaveBeenCalledWith({
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      tagline: "Your reliable personal assistant",
      avatarSeed: "__smithers__",
      personalityPresetId: "the-butler",
      greetingMessage: "Good day. I'm Smithers. How may I be of assistance?",
    });
    expect(agent).toEqual(fakeAgent);
  });

  it("uses Butler preset greeting message", async () => {
    const fakeAgent = {
      id: "agent-greeting-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      greetingMessage: "Good day. I'm Smithers. How may I be of assistance?",
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        greetingMessage: "Good day. I'm Smithers. How may I be of assistance?",
      })
    );
  });

  it("sets up workspace and writes SOUL.md", async () => {
    const fakeAgent = {
      id: "agent-shared-2",
      name: "Smithers",
      model: "openai/gpt-4o-mini",
      ownerId: null,
      isPersonal: false,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "openai/gpt-4o-mini",
      ownerId: null,
      isPersonal: false,
    });

    expect(ensureWorkspace).toHaveBeenCalledWith("agent-shared-2");
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "agent-shared-2",
      "SOUL.md",
      "# Smithers\n\nTest soul content"
    );
  });

  it("writes IDENTITY.md after creating agent", async () => {
    const fakeAgent = {
      id: "agent-identity-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      tagline: "Your reliable personal assistant",
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
    });

    expect(writeIdentityFile).toHaveBeenCalledWith("agent-identity-1", {
      name: "Smithers",
      tagline: "Your reliable personal assistant",
    });
  });

  it("returns the created agent", async () => {
    const fakeAgent = {
      id: "agent-shared-3",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-99",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    const agent = await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-99",
      isPersonal: true,
    });

    expect(agent).toEqual(fakeAgent);
  });
});

describe("seedPersonalAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates agent with ownerId and isPersonal = true", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    const agent = await seedPersonalAgent("user-1");

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-1",
        isPersonal: true,
      })
    );
    expect(agent.ownerId).toBe("user-1");
    expect(agent.isPersonal).toBe(true);
  });

  it("names the agent Smithers", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-2",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    const agent = await seedPersonalAgent("user-1");

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Smithers",
      })
    );
    expect(agent.name).toBe("Smithers");
  });

  it("calls ensureWorkspace with the new agent ID", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-workspace-test",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    await seedPersonalAgent("user-1");

    expect(ensureWorkspace).toHaveBeenCalledWith("agent-workspace-test");
  });

  it("writes Smithers SOUL.md to the workspace", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-soul-test",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    await seedPersonalAgent("user-1");

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "agent-soul-test",
      "SOUL.md",
      "# Smithers\n\nTest soul content"
    );
  });

  it("uses the default model from provider settings when available", async () => {
    getSettingMock.mockResolvedValue("openai");
    const fakeAgent = {
      id: "agent-3",
      name: "Smithers",
      model: "openai/gpt-4o-mini",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    await seedPersonalAgent("user-1");

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o-mini",
      })
    );
  });

  it("uses fallback model when no provider is configured", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-4",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    await seedPersonalAgent("user-1");

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-20250514",
      })
    );
  });

  it("returns the created agent", async () => {
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-5",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { seedPersonalAgent } = await import("@/lib/personal-agent");
    const agent = await seedPersonalAgent("user-1");

    expect(agent).toEqual(fakeAgent);
  });
});
