import { describe, it, expect, vi, beforeEach } from "vitest";
import { forceRunCronJob } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("forceRunCronJob", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls cron.run with mode='force' for an existing job", async () => {
    const mockRequest = vi.fn().mockResolvedValue({ result: { runId: "r-123" } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    const runId = await forceRunCronJob("job-abc");
    expect(mockRequest).toHaveBeenCalledWith("cron.run", { id: "job-abc", mode: "force" });
    expect(runId).toBe("r-123");
  });

  it("propagates errors from the gateway", async () => {
    vi.mocked(client.getOpenClawClient).mockReturnValue({
      request: vi.fn().mockRejectedValue(new Error("job not found")),
    } as any);
    await expect(forceRunCronJob("missing")).rejects.toThrow(/job not found/);
  });

  it("throws when gateway returns no runId", async () => {
    vi.mocked(client.getOpenClawClient).mockReturnValue({
      request: vi.fn().mockResolvedValue({ result: {} }),
    } as any);
    await expect(forceRunCronJob("job-abc")).rejects.toThrow(/runId/);
  });
});
