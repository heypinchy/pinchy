import { describe, it, expect, vi, beforeEach } from "vitest";

// Since OpenClaw 2026.9 the pending requests live in its state database and
// the pinchy-audit plugin looks a code up for us (`pinchy.pairing.findByCode`).
const { mockCallPairingStore } = vi.hoisted(() => ({ mockCallPairingStore: vi.fn() }));
vi.mock("@/lib/openclaw-pairing-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-pairing-store")>()),
  callPairingStore: mockCallPairingStore,
}));

import { OpenClawNotConnectedError } from "@/lib/openclaw-pairing-store";
import { resolvePairingCode } from "@/lib/telegram-pairing";

function pending(request: Record<string, unknown> | null) {
  mockCallPairingStore.mockResolvedValue({ request });
}

describe("resolvePairingCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns telegram user ID for valid pairing code", async () => {
    pending({ id: "8754697762", code: "FMSVEN7M", createdAt: new Date().toISOString() });

    const result = await resolvePairingCode("FMSVEN7M");
    expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
    expect(mockCallPairingStore).toHaveBeenCalledWith("pinchy.pairing.findByCode", {
      code: "FMSVEN7M",
    });
  });

  it("asks for the code trimmed, leaving case to the store's own match", async () => {
    pending({ id: "12345", code: "ABC123", createdAt: new Date().toISOString() });

    const result = await resolvePairingCode("  abc123 ");
    expect(result).toEqual({ found: true, telegramUserId: "12345" });
    expect(mockCallPairingStore).toHaveBeenCalledWith("pinchy.pairing.findByCode", {
      code: "abc123",
    });
  });

  it("returns not found for unknown code", async () => {
    pending(null);

    const result = await resolvePairingCode("WRONG");
    expect(result).toEqual({ found: false });
  });

  it("reports the lookup unavailable, not the code invalid, while OpenClaw is disconnected", async () => {
    mockCallPairingStore.mockRejectedValue(new OpenClawNotConnectedError());

    const result = await resolvePairingCode("ABC123");
    expect(result).toEqual({ found: false, unavailable: true });
  });

  it("returns not found when the answer carries no request", async () => {
    mockCallPairingStore.mockResolvedValue({});

    const result = await resolvePairingCode("ABC123");
    expect(result).toEqual({ found: false });
  });

  it("regression: logs a warning and reports unavailable when the lookup fails", async () => {
    // On v0.5.0 staging the pairing file was unreadable (root:0600) and a bare
    // catch{} turned that into a misleading "Invalid or expired pairing code".
    // A failed lookup must be visible in the logs and must not read as a
    // wrong code.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCallPairingStore.mockRejectedValue(
      new Error("pinchy.pairing.findByCode failed: database is locked")
    );

    const result = await resolvePairingCode("VVN2THRM");
    expect(result).toEqual({ found: false, unavailable: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[telegram-pairing]"),
      expect.stringContaining("database is locked")
    );
    warnSpy.mockRestore();
  });

  it("does NOT log when the code simply is not pending", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    pending(null);

    const result = await resolvePairingCode("VVN2THRM");
    expect(result).toEqual({ found: false });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("regression: matches the staging request shape (with lastSeenAt and accountId)", async () => {
    // The request a staging user redeemed on 2026-04-29, as OpenClaw now
    // stores it. `now` is pinned just after `lastSeenAt` so the expiry below
    // does not reject the old fixture against today's date.
    pending({
      id: "8754697762",
      code: "VVN2THRM",
      accountId: "ffa4180a-b920-42f0-9ee1-c61250e952ed",
      createdAt: "2026-04-29T16:52:07.768Z",
      lastSeenAt: "2026-04-29T16:56:04.803Z",
    });

    const result = await resolvePairingCode("VVN2THRM", Date.parse("2026-04-29T16:56:10.000Z"));
    expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
  });

  describe("pairing code expiry", () => {
    const CREATED_AT = "2026-04-29T16:52:07.768Z";
    const CREATED_AT_MS = Date.parse(CREATED_AT);

    function writePairingFile(request: Record<string, unknown>) {
      pending({ id: "8754697762", code: "VVN2THRM", ...request });
    }

    beforeEach(() => {
      writePairingFile({ createdAt: CREATED_AT });
    });

    it("accepts a code redeemed just under the 10-minute expiry", async () => {
      const justUnderTenMinutes = CREATED_AT_MS + 10 * 60_000 - 1;
      const result = await resolvePairingCode("VVN2THRM", justUnderTenMinutes);
      expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
    });

    it("rejects a code redeemed at exactly the 10-minute expiry", async () => {
      const tenMinutesLater = CREATED_AT_MS + 10 * 60_000;
      const result = await resolvePairingCode("VVN2THRM", tenMinutesLater);
      expect(result).toEqual({ found: false });
    });

    it("rejects a code redeemed well past the expiry (brute-force window closed)", async () => {
      const oneHourLater = CREATED_AT_MS + 60 * 60_000;
      const result = await resolvePairingCode("VVN2THRM", oneHourLater);
      expect(result).toEqual({ found: false });
    });

    // The recovery path the route's own error message promises ("Send a new
    // message to the bot and try again"). OpenClaw's pairing store hands back
    // the SAME code with the ORIGINAL createdAt for a request that is still
    // pending — only lastSeenAt moves. Measured from createdAt, messaging the
    // bot would therefore change nothing and the user would stay locked out
    // of a self-service flow until OpenClaw's own one-hour TTL expired.
    it("accepts a stale-by-createdAt code the peer has just messaged about again", async () => {
      const halfAnHourLater = CREATED_AT_MS + 30 * 60_000;
      writePairingFile({
        createdAt: CREATED_AT,
        lastSeenAt: new Date(halfAnHourLater).toISOString(),
      });

      const result = await resolvePairingCode("VVN2THRM", halfAnHourLater + 1_000);
      expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
    });

    it("rejects once 10 minutes have passed since the last contact too", async () => {
      const lastSeenMs = CREATED_AT_MS + 30 * 60_000;
      writePairingFile({
        createdAt: CREATED_AT,
        lastSeenAt: new Date(lastSeenMs).toISOString(),
      });

      const result = await resolvePairingCode("VVN2THRM", lastSeenMs + 10 * 60_000);
      expect(result).toEqual({ found: false });
    });

    it("falls back to createdAt when lastSeenAt is absent or unreadable", async () => {
      // Pre-lastSeenAt files, and files where the field is present but junk.
      for (const request of [
        { createdAt: CREATED_AT },
        { createdAt: CREATED_AT, lastSeenAt: "not-a-date" },
      ]) {
        writePairingFile(request);
        expect(await resolvePairingCode("VVN2THRM", CREATED_AT_MS + 1_000)).toEqual({
          found: true,
          telegramUserId: "8754697762",
        });
        expect(await resolvePairingCode("VVN2THRM", CREATED_AT_MS + 20 * 60_000)).toEqual({
          found: false,
        });
      }
    });

    it("rejects a code with an unparseable createdAt (fail closed, not open)", async () => {
      writePairingFile({ createdAt: "not-a-date" });

      const result = await resolvePairingCode("VVN2THRM", CREATED_AT_MS);
      expect(result).toEqual({ found: false });
    });
  });
});
