import { describe, it, expect, vi, beforeEach } from "vitest";
import { removeCronJobByName } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("removeCronJobByName", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls cron.remove when job exists", async () => {
    const mockRequest = vi
      .fn()
      .mockResolvedValueOnce({ result: { jobs: [{ id: "j1", name: "pinchy-briefing-abc" }] } })
      .mockResolvedValueOnce({ result: { ok: true } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    await removeCronJobByName("pinchy-briefing-abc");
    expect(mockRequest).toHaveBeenNthCalledWith(2, "cron.remove", { id: "j1" });
  });

  it("is a no-op when job does not exist", async () => {
    const mockRequest = vi.fn().mockResolvedValue({ result: { jobs: [] } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    await removeCronJobByName("pinchy-briefing-abc");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
