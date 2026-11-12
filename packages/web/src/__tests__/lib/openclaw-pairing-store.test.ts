import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequest, client } = vi.hoisted(() => {
  const mockRequest = vi.fn();
  return { mockRequest, client: { isConnected: true, request: mockRequest } };
});
const { mockGetOpenClawClient } = vi.hoisted(() => ({
  mockGetOpenClawClient: vi.fn(() => client),
}));
vi.mock("@/server/openclaw-client", () => ({ getOpenClawClient: mockGetOpenClawClient }));

import {
  callPairingStore,
  OpenClawNotConnectedError,
  PAIRING_SET_ALLOW_FROM_METHOD,
} from "@/lib/openclaw-pairing-store";

describe("callPairingStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.isConnected = true;
    mockGetOpenClawClient.mockImplementation(() => client);
  });

  it("calls the pinchy-audit method over the gateway and answers its payload", async () => {
    mockRequest.mockResolvedValue({ ok: true, payload: { accounts: 1 } });

    await expect(
      callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, { allowFrom: {}, replaceAll: true })
    ).resolves.toEqual({ accounts: 1 });
    expect(mockRequest).toHaveBeenCalledWith("pinchy.pairing.setAllowFrom", {
      channel: "telegram",
      allowFrom: {},
      replaceAll: true,
    });
  });

  // openclaw-node resolves an error response instead of rejecting. Reading
  // it as success would drop a revocation without a word.
  it("throws when the gateway refuses the call", async () => {
    mockRequest.mockResolvedValue({
      ok: false,
      error: { code: "UNAVAILABLE", message: "database is locked" },
    });

    await expect(
      callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, { allowFrom: {}, replaceAll: true })
    ).rejects.toThrow(/pinchy.pairing.setAllowFrom failed: database is locked/);
  });

  it("throws OpenClawNotConnectedError without calling while the gateway is disconnected", async () => {
    client.isConnected = false;

    await expect(
      callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, { allowFrom: {}, replaceAll: true })
    ).rejects.toBeInstanceOf(OpenClawNotConnectedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // A gateway restart drops the socket under a pending call. openclaw-node
  // rejects it with a plain Error, which is the same situation as calling while
  // disconnected: the allow lists are rewritten when the connection is back.
  it("throws OpenClawNotConnectedError when the connection drops during the call", async () => {
    mockRequest.mockRejectedValue(
      new Error("Not connected to OpenClaw Gateway: connection closed")
    );

    await expect(
      callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, { allowFrom: {}, replaceAll: true })
    ).rejects.toBeInstanceOf(OpenClawNotConnectedError);
  });

  it("still throws a timeout as a failure, not as a disconnect", async () => {
    mockRequest.mockRejectedValue(new Error("Request pinchy.pairing.setAllowFrom timed out"));

    const call = callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, {
      allowFrom: {},
      replaceAll: true,
    });
    await expect(call).rejects.toThrow(/timed out/);
    await expect(call).rejects.not.toBeInstanceOf(OpenClawNotConnectedError);
  });

  it("throws OpenClawNotConnectedError before the client exists", async () => {
    mockGetOpenClawClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    await expect(
      callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, { allowFrom: {}, replaceAll: true })
    ).rejects.toBeInstanceOf(OpenClawNotConnectedError);
  });
});
