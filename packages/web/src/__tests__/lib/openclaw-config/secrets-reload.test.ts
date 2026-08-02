import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import { reloadSecretsInBackground } from "@/lib/openclaw-config/secrets-reload";

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
});
