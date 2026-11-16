import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import {
  _resetSecretsReloadQueue,
  reloadSecretsInBackground,
} from "@/lib/openclaw-config/secrets-reload";
import {
  _resetConfigPushState,
  configWriteInFlight,
  trackConfigPushSettled,
  trackConfigPushStarted,
  trackConfigWrite,
} from "@/lib/openclaw-config/push-state";

/** The push is fire-and-forget; let its microtasks run. */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("reloadSecretsInBackground (#943)", () => {
  let request: ReturnType<typeof vi.fn>;
  let hasMethod: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetConfigPushState();
    _resetSecretsReloadQueue();
    request = vi.fn().mockResolvedValue({ type: "res", id: "1", ok: true, payload: {} });
    hasMethod = vi.fn().mockReturnValue(true);
    mockGetClient.mockReturnValue({ request, hasMethod });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the gateway to re-resolve its secrets", async () => {
    // The whole point of #943: a rotated key sits in secrets.json, the emitted
    // config is byte-identical, so `config.apply` is (correctly) skipped. This
    // RPC is the only thing that makes the running OpenClaw drop the credential
    // it resolved at process start.
    reloadSecretsInBackground();
    await drain();

    expect(request).toHaveBeenCalledWith("secrets.reload");
  });

  it("warns instead of throwing when no OpenClaw client is connected", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    expect(() => reloadSecretsInBackground()).not.toThrow();
    await drain();

    expect(request).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("still calls a gateway that advertises no method list yet", async () => {
    // The advertised-method list is empty until the hello-ok handshake, so a
    // `hasMethod` gate cannot tell "gateway is too old" from "we reconnected a
    // moment ago" — and skipping on the latter would drop the rotation on a
    // gateway that supports it. A gateway that genuinely lacks the method
    // answers with an error, which is reported like any other refusal.
    hasMethod.mockReturnValue(false);

    reloadSecretsInBackground();
    await drain();

    expect(request).toHaveBeenCalledWith("secrets.reload");
  });

  it("warns instead of throwing when the RPC rejects", async () => {
    request.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));

    expect(() => reloadSecretsInBackground()).not.toThrow();
    await drain();

    expect(warnSpy).toHaveBeenCalled();
  });

  it("treats an ok:false response as a failure rather than success", async () => {
    // openclaw-node resolves the promise for an error response, so a bare
    // `await request(...)` would report a refused reload as a successful one.
    request.mockResolvedValue({
      type: "res",
      id: "1",
      ok: false,
      error: { code: "UNAVAILABLE", message: "secrets.reload failed" },
    });

    reloadSecretsInBackground();
    await drain();

    expect(warnSpy).toHaveBeenCalled();
    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toContain("secrets.reload failed");
  });

  it("does not call for a restart OpenClaw's own answer cannot justify", async () => {
    // OpenClaw answers every failed reload with the same "secrets.reload
    // failed" — a reload a concurrent config change superseded included, and
    // that change's own reload resolves the new credentials. Its log has the
    // cause; the warning must not send an operator to restart for nothing.
    request.mockResolvedValue({
      type: "res",
      id: "1",
      ok: false,
      error: { code: "UNAVAILABLE", message: "secrets.reload failed" },
    });

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).not.toMatch(/— restart OpenClaw to apply/);
    expect(warning).toMatch(/OpenClaw's log/);
  });

  // OpenClaw 2026.9 restarts the gateway when the secrets snapshot changes
  // under a hot reload that replaces plugin services
  // (GatewayHotReloadStaleSecretsError → "hot reload recovery: plugin service
  // replacement teardown"; staging, 2026-11-16: three reloads alongside an
  // apply for six new agents). So a reload is a config write like any other:
  // one at a time, after the one in flight.
  describe("one config write at a time", () => {
    function deferred() {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => (resolve = r));
      return { promise, resolve };
    }

    it("waits for a config write in flight before reloading", async () => {
      const apply = deferred();
      void trackConfigWrite(apply.promise);

      reloadSecretsInBackground();
      await drain();
      expect(request).not.toHaveBeenCalled();

      apply.resolve({ ok: true });
      await drain();
      expect(request).toHaveBeenCalledWith("secrets.reload");
    });

    it("waits until no push is about to send its own write", async () => {
      // A push reads config.get between its wait and its apply; a reload
      // slipping into that gap would run alongside the apply.
      vi.useFakeTimers();
      try {
        trackConfigPushStarted(1);
        reloadSecretsInBackground();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(request).not.toHaveBeenCalled();

        trackConfigPushSettled(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(request).toHaveBeenCalledWith("secrets.reload");
      } finally {
        vi.useRealTimers();
      }
    });

    it("is the write a push waits for while it is in flight", async () => {
      const reload = deferred();
      request.mockReturnValue(reload.promise);

      reloadSecretsInBackground();
      await drain();
      expect(request).toHaveBeenCalledTimes(1);
      expect(configWriteInFlight()).toBeDefined();

      reload.resolve({ type: "res", id: "1", ok: true, payload: {} });
      await drain();
      expect(configWriteInFlight()).toBeUndefined();
    });

    it("sends one reload for every request that queued behind the same write", async () => {
      const apply = deferred();
      void trackConfigWrite(apply.promise);

      reloadSecretsInBackground();
      reloadSecretsInBackground();
      reloadSecretsInBackground();
      apply.resolve({ ok: true });
      await drain();
      await drain();

      expect(request).toHaveBeenCalledTimes(1);
    });

    it("sends another reload for a request made while one is in flight", async () => {
      // The reload in flight may have read secrets.json before the write that
      // asked for this one.
      const first = deferred();
      request.mockReturnValueOnce(first.promise);

      reloadSecretsInBackground();
      await drain();
      reloadSecretsInBackground();
      await drain();
      expect(request).toHaveBeenCalledTimes(1);

      first.resolve({ type: "res", id: "1", ok: true, payload: {} });
      await drain();
      await drain();
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("does not wait out a write OpenClaw never answers", async () => {
      vi.useFakeTimers();
      try {
        void trackConfigWrite(new Promise(() => {}));

        reloadSecretsInBackground();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(request).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2_000);
        expect(request).toHaveBeenCalledWith("secrets.reload");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
