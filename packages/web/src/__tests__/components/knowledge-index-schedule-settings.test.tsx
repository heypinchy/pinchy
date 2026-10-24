// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { KnowledgeIndexScheduleSettings } from "@/components/knowledge-index-schedule-settings";
import { apiGet, apiPut, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn(), apiPut: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockGet = vi.mocked(apiGet);
const mockPut = vi.mocked(apiPut);

const URL = "/api/settings/knowledge-index-schedule";

const status = {
  enabled: true,
  time: "02:00",
  timezone: "Europe/Vienna",
  nextRun: { date: "2026-10-17", time: "02:00", day: "tomorrow" },
  currentSweep: null,
  lastSweep: null,
};

describe("KnowledgeIndexScheduleSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(status);
  });

  it("shows the nightly reindex as it is set, and when it runs next", async () => {
    render(<KnowledgeIndexScheduleSettings />);

    expect(await screen.findByRole("checkbox", { name: /reindex every night/i })).toBeChecked();
    expect(screen.getByLabelText(/time/i)).toHaveValue("02:00");
    expect(screen.getByText("Next run: tomorrow at 02:00 (Europe/Vienna).")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(URL);
  });

  // The timezone card sits right above this one. When the admin saves a new
  // zone there, "Time (UTC)" and "Next run … (UTC)" here would be wrong until
  // a reload — and a time picked against the stale label lands hours off.
  it("reloads when the page says the org timezone changed", async () => {
    const { rerender } = render(<KnowledgeIndexScheduleSettings refreshKey={0} />);
    await screen.findByText("Next run: tomorrow at 02:00 (Europe/Vienna).");
    mockGet.mockResolvedValue({ ...status, timezone: "America/New_York" });

    rerender(<KnowledgeIndexScheduleSettings refreshKey={1} />);

    expect(
      await screen.findByText("Next run: tomorrow at 02:00 (America/New_York).")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Time (America/New_York)")).toBeInTheDocument();
  });

  it("saves a new time and shows what happens next", async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue({
      ...status,
      time: "23:30",
      nextRun: { date: "2026-10-16", time: "23:30", day: "today" },
    });
    render(<KnowledgeIndexScheduleSettings />);
    const time = await screen.findByLabelText(/time/i);

    await user.clear(time);
    await user.type(time, "23:30");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(mockPut).toHaveBeenCalledWith(URL, { enabled: true, time: "23:30" });
    expect(
      await screen.findByText("Next run: today at 23:30 (Europe/Vienna).")
    ).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it("switches it off and says what that means", async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue({ ...status, enabled: false, nextRun: null });
    render(<KnowledgeIndexScheduleSettings />);

    await user.click(await screen.findByRole("checkbox", { name: /reindex every night/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(mockPut).toHaveBeenCalledWith(URL, { enabled: false, time: "02:00" });
    expect(
      await screen.findByText("Off. New documents show up only when an admin reindexes an agent.")
    ).toBeInTheDocument();
  });

  // A rejected time is the admin's to correct, so it belongs next to the
  // field rather than in a toast that disappears (AGENTS.md error policy).
  it("shows a rejected time inline, next to the field", async () => {
    const user = userEvent.setup();
    // The shape parseRequestBody answers with: the field's own message lives
    // in details.fieldErrors, the headline is generic.
    mockPut.mockRejectedValue(
      new ApiError(400, "Validation failed", {
        formErrors: [],
        fieldErrors: { time: ["Use a 24-hour time such as 02:00 or 23:30."] },
      })
    );
    render(<KnowledgeIndexScheduleSettings />);

    await screen.findByLabelText(/time/i);
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(
      await screen.findByText("Use a 24-hour time such as 02:00 or 23:30.")
    ).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports the night in progress", async () => {
    mockGet.mockResolvedValue({
      ...status,
      currentSweep: {
        slot: "2026-10-16",
        startedAt: "2026-10-16T00:00:00.000Z",
        agentCount: 3,
        waiting: 2,
      },
    });

    render(<KnowledgeIndexScheduleSettings />);

    expect(
      await screen.findByText(
        "Tonight's run is under way: 2 of 3 agents are still waiting their turn."
      )
    ).toBeInTheDocument();
  });

  it("reports the last night that ran", async () => {
    mockGet.mockResolvedValue({
      ...status,
      lastSweep: { slot: "2026-10-16", startedAt: "2026-10-16T00:00:00.000Z", agentCount: 2 },
    });

    render(<KnowledgeIndexScheduleSettings />);

    expect(
      await screen.findByText(/^Last nightly run: 2026-10-16, 2 agents\./)
    ).toBeInTheDocument();
  });

  it("names a single agent in the singular", async () => {
    mockGet.mockResolvedValue({
      ...status,
      lastSweep: { slot: "2026-10-16", startedAt: "2026-10-16T00:00:00.000Z", agentCount: 1 },
    });

    render(<KnowledgeIndexScheduleSettings />);

    expect(await screen.findByText(/^Last nightly run: 2026-10-16, 1 agent\./)).toBeInTheDocument();
  });

  it("stays out of the way if the status cannot be read", async () => {
    mockGet.mockRejectedValue(new Error("network down"));

    const { container } = render(<KnowledgeIndexScheduleSettings />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
