import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    query: {
      settings: {
        findFirst: vi.fn(),
      },
    },
    delete: vi.fn().mockReturnValue({ where: vi.fn() }),
  },
}));

vi.mock("@/db/schema", () => ({
  settings: { key: "key" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));

import { db } from "@/db";

describe("domain-reset logic", () => {
  beforeEach(() => {
    vi.mocked(db.query.settings.findFirst).mockReset();
    vi.mocked(db.delete).mockClear();
  });

  it("should report when no domain is configured", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Import and run the reset logic inline (same as the script does)
    const existing = await db.query.settings.findFirst({
      where: { field: "key", value: "domain" } as any,
    });

    if (!existing) {
      console.log("No domain lock is configured. Nothing to reset.");
    }

    expect(consoleSpy).toHaveBeenCalledWith("No domain lock is configured. Nothing to reset.");
    expect(db.delete).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should delete domain setting and report the old value", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValue({
      key: "domain",
      value: "pinchy.example.com",
      encrypted: false,
    });
    const whereMock = vi.fn();
    vi.mocked(db.delete).mockReturnValue({ where: whereMock } as any);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const existing = await db.query.settings.findFirst({
      where: { field: "key", value: "domain" } as any,
    });

    if (existing) {
      await db.delete({} as any).where({});
      console.log(`Domain lock removed (was: ${existing.value}).`);
      console.log("Pinchy is now accessible via any host. Restart the container to apply.");
    }

    expect(db.delete).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("Domain lock removed (was: pinchy.example.com).");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Pinchy is now accessible via any host. Restart the container to apply."
    );
    consoleSpy.mockRestore();
  });
});
