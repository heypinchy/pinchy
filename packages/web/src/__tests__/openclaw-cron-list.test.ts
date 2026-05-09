import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCronJobs } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("listCronJobs", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls cron.list and returns all jobs", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      result: { jobs: [{ id: "j1", name: "pinchy-briefing-abc" }] },
    });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    const jobs = await listCronJobs();
    expect(mockRequest).toHaveBeenCalledWith("cron.list", {});
    expect(jobs).toEqual([{ id: "j1", name: "pinchy-briefing-abc" }]);
  });

  it("filters by name prefix when provided", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      result: {
        jobs: [
          { id: "j1", name: "pinchy-briefing-abc" },
          { id: "j2", name: "something-else" },
        ],
      },
    });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    const jobs = await listCronJobs({ namePrefix: "pinchy-briefing-" });
    expect(jobs).toEqual([{ id: "j1", name: "pinchy-briefing-abc" }]);
  });
});
