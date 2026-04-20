import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthorizationRequest } from "./device-code";

describe("createAuthorizationRequest", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to the device-code endpoint with client_id and scope", async () => {
    const mockResponse = {
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.openai.com/codex/device",
      verification_uri_complete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200, headers: { "content-type": "application/json" } })
    );

    const result = await createAuthorizationRequest({
      clientId: "app_TEST",
      scope: "openid profile email offline_access",
    });

    expect(result).toEqual({
      deviceCode: "dev-123",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      verificationUriComplete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded" }),
      })
    );
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as string;
    expect(body).toContain("client_id=app_TEST");
    expect(body).toContain("scope=openid+profile+email+offline_access");
  });

  it("throws when the server returns a non-2xx", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("nope", { status: 500 })
    );
    await expect(
      createAuthorizationRequest({ clientId: "app_TEST", scope: "openid" })
    ).rejects.toThrow(/device.code request failed/i);
  });
});
