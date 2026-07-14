/**
 * Unit tests for the conflict-restart handler (#477 layer 3) — the server-side
 * implementation behind the watchdog's `restartConflictedAccount` dep. It
 * bounces one channel account through the gateway's runtime-only
 * `channels.stop` / `channels.start` RPCs (no config writes) and audits the
 * action as `channel.restarted`, so a Telegram bot stuck in OpenClaw's
 * dormant post-409 ingress backoff resumes polling under Pinchy's control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConflictRestartHandler } from "@/server/channel-conflict-restart";

const ACCOUNT = "29ea51b1-67af-4fad-8864-f550c7543333";
const CONFLICT =
  "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running";

describe("createConflictRestartHandler", () => {
  let request: ReturnType<typeof vi.fn>;
  let isConflictDisabled: ReturnType<typeof vi.fn>;
  let resolveAccountName: ReturnType<typeof vi.fn>;
  let writeAudit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ ok: true });
    isConflictDisabled = vi.fn().mockResolvedValue(false);
    resolveAccountName = vi.fn().mockResolvedValue("Penny");
    writeAudit = vi.fn().mockResolvedValue(undefined);
  });

  function handler() {
    return createConflictRestartHandler({
      request,
      isConflictDisabled,
      resolveAccountName,
      writeAudit,
    });
  }

  function auditEntries() {
    return writeAudit.mock.calls.map((c) => c[0]);
  }

  it("stops then starts the account and audits channel.restarted with outcome success", async () => {
    await handler()("telegram", ACCOUNT, CONFLICT, 1);

    expect(request).toHaveBeenNthCalledWith(1, "channels.stop", {
      channel: "telegram",
      accountId: ACCOUNT,
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.start", {
      channel: "telegram",
      accountId: ACCOUNT,
    });

    const entries = auditEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.eventType).toBe("channel.restarted");
    expect(e.actorType).toBe("system");
    expect(e.actorId).toBe("channel-watchdog");
    expect(e.resource).toBe(`agent:${ACCOUNT}`);
    expect(e.outcome).toBe("success");
    expect(e.detail.channel).toBe("telegram");
    expect(e.detail.account).toEqual({ id: ACCOUNT, name: "Penny" });
    expect(e.detail.reason).toBe("polling_conflict");
    expect(e.detail.restartAttempt).toBe(1);
    expect(e.detail.lastError).toContain("terminated by other getUpdates request");
  });

  it("skips the RPCs and the audit entirely when the account is already conflict-disabled", async () => {
    isConflictDisabled.mockResolvedValue(true);
    await handler()("telegram", ACCOUNT, CONFLICT, 1);
    expect(request).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("audits outcome failure with the gateway error when channels.start is rejected by the gateway", async () => {
    request
      .mockResolvedValueOnce({ ok: true }) // stop
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "unknown account" },
      });

    await handler()("telegram", ACCOUNT, CONFLICT, 2);

    const e = auditEntries()[0];
    expect(e.outcome).toBe("failure");
    expect(e.detail.restartAttempt).toBe(2);
    expect(e.detail.error).toContain("unknown account");
  });

  it("audits outcome failure and does not throw when the RPC itself rejects (timeout/disconnect)", async () => {
    request.mockRejectedValue(new Error("Request channels.stop timed out"));
    await expect(handler()("telegram", ACCOUNT, CONFLICT, 1)).resolves.toBeUndefined();
    const e = auditEntries()[0];
    expect(e.outcome).toBe("failure");
    expect(e.detail.error).toContain("timed out");
  });

  it("tolerates a failing channels.stop (account not running) as long as channels.start succeeds", async () => {
    request
      .mockResolvedValueOnce({ ok: false, error: { code: "UNAVAILABLE", message: "not running" } })
      .mockResolvedValueOnce({ ok: true });

    await handler()("telegram", ACCOUNT, CONFLICT, 1);

    expect(request).toHaveBeenCalledTimes(2);
    expect(auditEntries()[0].outcome).toBe("success");
  });

  it("audits with a null name when resolveAccountName rejects", async () => {
    resolveAccountName.mockRejectedValue(new Error("db down"));
    await handler()("telegram", ACCOUNT, CONFLICT, 1);
    expect(auditEntries()[0].detail.account).toEqual({ id: ACCOUNT, name: null });
  });

  it("scrubs email PII from lastError before it lands in the audit detail", async () => {
    await handler()("telegram", ACCOUNT, "poll failed for admin@example.com: conflict", 1);
    const e = auditEntries()[0];
    expect(e.detail.lastError).not.toContain("admin@example.com");
    expect(e.detail.lastError).toContain("<email-redacted>");
  });
});
