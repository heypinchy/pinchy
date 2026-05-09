import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertCronJob } from "@/server/openclaw-cron";
import * as client from "@/server/openclaw-client";

vi.mock("@/server/openclaw-client");

describe("upsertCronJob", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls cron.add when job not found", async () => {
    const mockRequest = vi
      .fn()
      .mockResolvedValueOnce({ result: { jobs: [] } })
      .mockResolvedValueOnce({ result: { id: "new-id" } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    await upsertCronJob({
      name: "pinchy-briefing-abc",
      agentId: "agent-1",
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Vienna" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hi" },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        name: "pinchy-briefing-abc",
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Vienna" },
      })
    );
  });

  it("calls cron.update when job exists", async () => {
    const mockRequest = vi
      .fn()
      .mockResolvedValueOnce({
        result: { jobs: [{ id: "existing", name: "pinchy-briefing-abc" }] },
      })
      .mockResolvedValueOnce({ result: { ok: true } });
    vi.mocked(client.getOpenClawClient).mockReturnValue({ request: mockRequest } as any);

    await upsertCronJob({
      name: "pinchy-briefing-abc",
      agentId: "agent-1",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Vienna" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hi" },
    });

    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      "cron.update",
      expect.objectContaining({
        id: "existing",
      })
    );
  });
});
