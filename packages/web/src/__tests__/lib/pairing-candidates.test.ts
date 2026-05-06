import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockSelect(),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

import {
  getOrgPairingSmithers,
  PAIRING_PUBLIC_AGENT_ID,
  PAIRING_PUBLIC_AGENT_NAME,
} from "@/lib/pairing-candidates";

describe("getOrgPairingSmithers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no Smithers personal agents exist", async () => {
    mockSelect.mockResolvedValueOnce([]);

    const result = await getOrgPairingSmithers(new Set());

    expect(result).toEqual([]);
  });

  it("returns the oldest Smithers anonymized as a single pairing candidate", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "admin-smithers-1",
        name: "MyBoss",
        createdAt: new Date("2026-01-01"),
        avatarSeed: "__smithers__",
        isPersonal: true,
      },
      {
        id: "admin-smithers-2",
        name: "OtherAdminBot",
        createdAt: new Date("2026-02-01"),
        avatarSeed: "__smithers__",
        isPersonal: true,
      },
    ]);

    const result = await getOrgPairingSmithers(new Set());

    expect(result).toHaveLength(1);
    expect(result[0].realId).toBe("admin-smithers-1");
    expect(result[0].publicId).toBe(PAIRING_PUBLIC_AGENT_ID);
    expect(result[0].publicName).toBe(PAIRING_PUBLIC_AGENT_NAME);
    expect(result[0].isPersonal).toBe(true);
  });

  it("does not leak the admin's customized agent name (anonymized)", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "admin-1",
        name: "Custom HR Bot",
        createdAt: new Date("2026-01-01"),
        avatarSeed: "__smithers__",
        isPersonal: true,
      },
    ]);

    const result = await getOrgPairingSmithers(new Set());

    expect(result[0].publicName).not.toBe("Custom HR Bot");
    expect(result[0].publicId).not.toBe("admin-1");
  });

  it("excludes Smithers agents already visible to the user (no duplicates)", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "user-own-smithers",
        name: "Smithers",
        createdAt: new Date("2026-03-01"),
        avatarSeed: "__smithers__",
        isPersonal: true,
      },
    ]);

    const visibleIds = new Set(["user-own-smithers"]);
    const result = await getOrgPairingSmithers(visibleIds);

    expect(result).toEqual([]);
  });
});
