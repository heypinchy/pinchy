import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCronRuns } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("listCronRuns", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls cron.runs with jobId and returns entries", async () => {
    const entries = [
      {
        runId: "r1",
        jobId: "j1",
        status: "ok",
        runAtMs: 1,
        durationMs: 100,
        usage: { input_tokens: 10, output_tokens: 20 },
        sessionKey: "cron:j1",
      },
    ];
    const mockRequest = vi.fn().mockResolvedValue({ result: { runs: entries } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    const runs = await listCronRuns({ jobId: "j1" });
    expect(mockRequest).toHaveBeenCalledWith("cron.runs", { jobId: "j1" });
    expect(runs).toEqual(entries);
  });

  it("passes fromMs and status filters through", async () => {
    const mockRequest = vi.fn().mockResolvedValue({ result: { runs: [] } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    await listCronRuns({ jobId: "j1", fromMs: 100, status: "error", limit: 50 });
    expect(mockRequest).toHaveBeenCalledWith("cron.runs", {
      jobId: "j1",
      fromMs: 100,
      status: "error",
      limit: 50,
    });
  });
});
