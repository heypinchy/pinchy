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
  };

  const mockTimeseriesResponse = {
    data: [
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

  function mockBothEndpoints(
    summaryOverride?: object,
    timeseriesOverride?: object,
    enterpriseOverride?: boolean
  ) {
    vi.mocked(global.fetch).mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: enterpriseOverride ?? false }),
        } as Response);
      }
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
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("Research Bot").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
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

  it("should fetch with days=0 when 'All' is clicked", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    await user.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=0");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=0");
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
    mockBothEndpoints({ agents: [] }, { data: [] });
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

  describe("enterprise features", () => {
    const mockByUserResponse = {
      users: [
        {
          userId: "user-1",
          userName: "Alice",
          totalInputTokens: "300000",
          totalOutputTokens: "400000",
          totalCost: "2.10",
        },
        {
          userId: "user-2",
          userName: "Bob",
          totalInputTokens: "200000",
          totalOutputTokens: "150000",
          totalCost: "1.05",
        },
      ],
    };

    function mockAllEndpoints() {
      vi.mocked(global.fetch).mockImplementation((url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/enterprise/status")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ enterprise: true }),
          } as Response);
        }
        if (urlStr.includes("/api/usage/summary")) {
          return Promise.resolve({
            ok: true,
            json: async () => mockSummaryResponse,
          } as Response);
        }
        if (urlStr.includes("/api/usage/timeseries")) {
          return Promise.resolve({
            ok: true,
            json: async () => mockTimeseriesResponse,
          } as Response);
        }
        if (urlStr.includes("/api/usage/by-user")) {
          return Promise.resolve({
            ok: true,
            json: async () => mockByUserResponse,
          } as Response);
        }
        return Promise.resolve({
          ok: false,
          json: async () => ({}),
        } as Response);
      });
    }

    it("should show 'By User' tab when enterprise", async () => {
      mockBothEndpoints();
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      expect(screen.getByRole("tab", { name: "By User" })).toBeInTheDocument();
    });

    it("should fetch from /api/usage/by-user when 'By User' tab is clicked", async () => {
      mockAllEndpoints();
      const user = userEvent.setup();
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByRole("tab", { name: "By User" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/usage/by-user"));
      });
    });

    it("should display per-user table with user names and values", async () => {
      mockAllEndpoints();
      const user = userEvent.setup();
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByRole("tab", { name: "By User" }));

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("Bob")).toBeInTheDocument();
      });

      expect(screen.getByText("$2.10")).toBeInTheDocument();
      expect(screen.getByText("$1.05")).toBeInTheDocument();
    });

    it("should show 'By User' tab even when not enterprise", async () => {
      mockBothEndpoints();
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      expect(screen.getByRole("tab", { name: "By User" })).toBeInTheDocument();
    });

    it("should show enterprise feature card when 'By User' tab clicked without enterprise", async () => {
      mockBothEndpoints();
      const user = userEvent.setup();
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByRole("tab", { name: "By User" }));

      await waitFor(() => {
        expect(screen.getByText("Enterprise")).toBeInTheDocument();
      });
    });

    it("should show 'Export CSV' button always but disabled without enterprise", async () => {
      mockBothEndpoints();
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      const exportBtn = screen.getByRole("button", { name: "Export CSV" });
      expect(exportBtn).toBeInTheDocument();
      expect(exportBtn).toBeDisabled();
    });

    it("should enable 'Export CSV' button when enterprise", async () => {
      mockBothEndpoints(undefined, undefined, true);
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      const exportBtn = screen.getByRole("button", { name: "Export CSV" });
      expect(exportBtn).toBeEnabled();
    });

    it("should use correct URL for export button", async () => {
      mockBothEndpoints(undefined, undefined, true);
      const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      const user = userEvent.setup();
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      expect(windowOpenSpy).toHaveBeenCalledWith("/api/usage/export?format=csv&days=30");

      windowOpenSpy.mockRestore();
    });
  });

  it("should render agent filter dropdown with 'All Agents' default", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    const agentSelect = screen.getByLabelText("Filter by agent");
    expect(agentSelect).toBeInTheDocument();
    expect(agentSelect).toHaveValue("all");
  });

  it("should populate agent filter with agent names from summary data", async () => {
    mockBothEndpoints();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    const agentSelect = screen.getByLabelText("Filter by agent");
    const options = agentSelect.querySelectorAll("option");
    expect(options).toHaveLength(3); // "All Agents" + 2 agents
    expect(options[0]).toHaveTextContent("All Agents");
    expect(options[1]).toHaveTextContent("Smithers");
    expect(options[2]).toHaveTextContent("Research Bot");
  });

  it("should re-fetch with agentId when an agent is selected", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    const agentSelect = screen.getByLabelText("Filter by agent");
    await user.selectOptions(agentSelect, "agent-1");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=30&agentId=agent-1");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=30&agentId=agent-1");
    });
  });

  it("should remove agentId param when 'All Agents' is re-selected", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    const agentSelect = screen.getByLabelText("Filter by agent");
    await user.selectOptions(agentSelect, "agent-1");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("agentId=agent-1"));
    });

    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    await user.selectOptions(agentSelect, "all");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=30");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=30");
    });
  });
});
