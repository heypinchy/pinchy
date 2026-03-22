import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UsageDashboard } from "@/components/usage-dashboard";

// recharts uses ResponsiveContainer which needs dimensions — mock it
vi.mock("recharts", async () => {
  const Original = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...Original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="chart-container" style={{ width: 800, height: 300 }}>
        {children}
      </div>
    ),
  };
});

describe("UsageDashboard", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockSummaryResponse = {
    agents: [
      {
        agentId: "agent-1",
        agentName: "Smithers",
        totalInputTokens: "500000",
        totalOutputTokens: "700000",
        totalCost: "3.50",
      },
      {
        agentId: "agent-2",
        agentName: "Research Bot",
        totalInputTokens: "150000",
        totalOutputTokens: "250000",
        totalCost: "1.32",
      },
    ],
    totals: {
      totalInputTokens: "650000",
      totalOutputTokens: "950000",
      totalCost: "4.82",
    },
  };

  const mockTimeseriesResponse = {
    points: [
      {
        date: "2026-03-20",
        inputTokens: "200000",
        outputTokens: "300000",
        cost: "1.50",
      },
      {
        date: "2026-03-21",
        inputTokens: "450000",
        outputTokens: "650000",
        cost: "3.32",
      },
    ],
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockBothEndpoints(summaryOverride?: object, timeseriesOverride?: object) {
    vi.mocked(global.fetch).mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/usage/summary")) {
        return Promise.resolve({
          ok: true,
          json: async () => summaryOverride ?? mockSummaryResponse,
        } as Response);
      }
      if (urlStr.includes("/api/usage/timeseries")) {
        return Promise.resolve({
          ok: true,
          json: async () => timeseriesOverride ?? mockTimeseriesResponse,
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        json: async () => ({}),
      } as Response);
    });
  }

  it("should render heading 'Usage & Costs'", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    expect(screen.getByText("Usage & Costs")).toBeInTheDocument();
  });

  it("should fetch from both API endpoints on mount", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/usage/summary"));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/usage/timeseries"));
    });
  });

  it("should fetch with days=30 by default", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=30");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=30");
    });
  });

  it("should show loading state initially", () => {
    vi.mocked(global.fetch).mockReturnValue(new Promise(() => {}));
    render(<UsageDashboard />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("should display summary cards with formatted token counts", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      // 650000 + 950000 = 1600000 -> "1.6M"
      expect(screen.getByText("1.6M")).toBeInTheDocument();
    });

    expect(screen.getByText("$4.82")).toBeInTheDocument();
  });

  it("should display agent table with agent names and formatted values", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Smithers")).toBeInTheDocument();
    });

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    // 500000 -> "500.0k"
    expect(screen.getByText("500.0k")).toBeInTheDocument();
    // 700000 -> "700.0k"
    expect(screen.getByText("700.0k")).toBeInTheDocument();
    expect(screen.getByText("$3.50")).toBeInTheDocument();
    expect(screen.getByText("$1.32")).toBeInTheDocument();
  });

  it("should change fetch parameters when time period buttons are clicked", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Smithers")).toBeInTheDocument();
    });

    // Clear mock call history
    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    await user.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=7");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=7");
    });
  });

  it("should fetch without days param when 'All' is clicked", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Smithers")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    await user.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries");
    });
  });

  it("should render the chart container", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId("chart-container")).toBeInTheDocument();
    });
  });

  it("should show 'No usage data' when summary has no agents", async () => {
    mockBothEndpoints(
      {
        agents: [],
        totals: {
          totalInputTokens: "0",
          totalOutputTokens: "0",
          totalCost: "0",
        },
      },
      { points: [] }
    );
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No usage data available.")).toBeInTheDocument();
    });
  });

  it("should render all time period buttons", () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    expect(screen.getByRole("button", { name: "7d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "90d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
  });
});
