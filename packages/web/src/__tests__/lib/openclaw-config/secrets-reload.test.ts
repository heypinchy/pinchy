import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetClient, mockForgetSecretsWrite } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockForgetSecretsWrite: vi.fn(),
}));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-secrets")>()),
  forgetSecretsWrite: mockForgetSecretsWrite,
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

  it("reports a refused reload as a failure rather than success", async () => {
    // openclaw-node rejects the request with the gateway's error message when
    // OpenClaw answers ok:false.
    request.mockRejectedValue(new Error("unresolved SecretRef providers/x/apiKey"));

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toMatch(/refused by the gateway \(unresolved SecretRef providers\/x\/apiKey\)/);
  });

  it("reads openclaw-node's own fallback message for an ok:false answer as a refusal", async () => {
    // With no error message from the gateway, openclaw-node rejects with
    // "Request failed: <id>" — still an answer, not a lost connection.
    request.mockRejectedValue(new Error("Request failed: 1731-abc"));

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toMatch(/refused by the gateway/);
  });

  it.each([
    "Not connected to OpenClaw Gateway",
    "Not connected to OpenClaw Gateway: connection closed",
    "Not connected to OpenClaw Gateway: connection error",
  ])("does not send an operator to restart a gateway it merely lost (%s)", async (message) => {
    // The socket is down in practice because OpenClaw is restarting, and a
    // restarting OpenClaw reads the new file on its way up. Telling the
    // operator to restart would take every agent down for nothing.
    request.mockRejectedValue(new Error(message));

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toMatch(/OpenClaw was unreachable/);
    expect(warning).not.toMatch(/refused by the gateway/);
  });

  it("calls for a restart when the reload timed out instead of calling it refused", async () => {
    // A hung gateway or a half-open socket ends in openclaw-node's request
    // timeout, not an answer — there is no OpenClaw log line to point at.
    request.mockRejectedValue(new Error("Request secrets.reload timed out"));

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toMatch(/— restart OpenClaw to apply/);
    expect(warning).not.toMatch(/refused by the gateway/);
  });

  it("reads a gateway answer that merely ends in 'timed out' as a refusal", async () => {
    // Only openclaw-node's own "Request <method> timed out" means no answer
    // came back. An ok:false message from OpenClaw that happens to end the same
    // way is still OpenClaw's answer, and its log names the cause.
    request.mockRejectedValue(new Error("provider lookup timed out"));

    reloadSecretsInBackground();
    await drain();

    const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warning).toMatch(/refused by the gateway/);
  });

  it("does not call for a restart OpenClaw's own answer cannot justify", async () => {
    // OpenClaw answers every failed reload with the same "secrets.reload
    // failed" — a reload a concurrent config change superseded included, and
    // that change's own reload resolves the new credentials. Its log has the
    // cause; the warning must not send an operator to restart for nothing.
    request.mockRejectedValue(new Error("secrets.reload failed"));

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

    it("claims the write slot before it returns, when nothing is in flight", () => {
      // A regenerate asks for the reload and starts its push in one synchronous
      // turn; the push checks for a write in flight in that same turn. The
      // interaction itself is pinned in openclaw-config.test.ts ("secrets.reload
      // and a push requested in the same turn").
      request.mockReturnValue(new Promise(() => {}));

      reloadSecretsInBackground();

      expect(request).toHaveBeenCalledWith("secrets.reload");
      expect(configWriteInFlight()).toBeDefined();
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
        const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
        expect(warning).toMatch(/config write is still unanswered/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the unanswered write tracked when it sends over it", async () => {
      // Later pushes still have to wait for that apply; the reload must not
      // take its place in the slot.
      vi.useFakeTimers();
      try {
        void trackConfigWrite(new Promise(() => {}));
        const apply = configWriteInFlight();
        request.mockReturnValue(new Promise(() => {}));

        reloadSecretsInBackground();
        await vi.advanceTimersByTimeAsync(16_000);

        expect(request, "precondition: the reload went out").toHaveBeenCalled();
        expect(configWriteInFlight()).toBe(apply);
      } finally {
        vi.useRealTimers();
      }
    });

    it("says a push held it, not a write, when only a push was pending", async () => {
      // A push parked in a rate-limit wait counts as pending for minutes
      // without a write in flight.
      vi.useFakeTimers();
      try {
        trackConfigPushStarted(1);

        reloadSecretsInBackground();
        await vi.advanceTimersByTimeAsync(16_000);

        expect(request).toHaveBeenCalledWith("secrets.reload");
        const warning = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
        expect(warning).not.toMatch(/unanswered/);
        expect(warning).toMatch(/push/);
      } finally {
        trackConfigPushSettled(1);
        vi.useRealTimers();
      }
    });
  });

  // The write record (openclaw-secrets.ts) says what is on disk, not what
  // OpenClaw holds. A reload that did not land has to be asked for again by
  // the next regenerate, even when the bundle is the same.
  describe("a reload that did not land", () => {
    it("forgets the write when no client is connected", async () => {
      mockGetClient.mockReturnValue(undefined);
      reloadSecretsInBackground();
      await drain();
      expect(mockForgetSecretsWrite).toHaveBeenCalledTimes(1);
    });

    it("forgets the write when OpenClaw refuses the reload", async () => {
      request.mockRejectedValue(new Error("secrets.reload failed"));
      reloadSecretsInBackground();
      await drain();
      expect(mockForgetSecretsWrite).toHaveBeenCalledTimes(1);
    });

    it("forgets the write when the request fails", async () => {
      request.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));
      reloadSecretsInBackground();
      await drain();
      expect(mockForgetSecretsWrite).toHaveBeenCalledTimes(1);
    });

    it("keeps the write once OpenClaw re-resolved its secrets", async () => {
      reloadSecretsInBackground();
      await drain();
      expect(mockForgetSecretsWrite).not.toHaveBeenCalled();
    });
  });
});
