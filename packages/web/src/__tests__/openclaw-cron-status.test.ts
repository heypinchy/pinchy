import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCronStatus } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("getCronStatus", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the cron.status payload", async () => {
    const payload = { enabled: 5, disabled: 1, running: 0, nextFireAtMs: 1_700_000_000_000 };
    const mockRequest = vi.fn().mockResolvedValue({ result: payload });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    const status = await getCronStatus();
    expect(mockRequest).toHaveBeenCalledWith("cron.status", {});
    expect(status).toEqual(payload);
  });
});
