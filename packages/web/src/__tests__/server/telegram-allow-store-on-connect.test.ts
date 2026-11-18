import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { syncTelegramAllowStoresOnConnect } from "@/server/telegram-allow-store-on-connect";

describe("syncTelegramAllowStoresOnConnect", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // The writes Pinchy skipped while OpenClaw was away, and the lists an older
  // OpenClaw kept in files, reach OpenClaw's store only through this run.
  it("recalculates the allow lists", async () => {
    const recalculate = vi.fn().mockResolvedValue(undefined);

    await syncTelegramAllowStoresOnConnect(recalculate);

    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("logs a failed run instead of rejecting the connected handler", async () => {
    const recalculate = vi.fn().mockRejectedValue(new Error("database is locked"));

    await expect(syncTelegramAllowStoresOnConnect(recalculate)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[telegram-allow-store]",
      "failed to sync the allow lists after connecting:",
      "database is locked"
    );
  });
});
