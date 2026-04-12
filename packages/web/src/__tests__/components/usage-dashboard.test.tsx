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

  describe("source breakdown cards", () => {
    it("renders chat/system/plugin cards when totals include all three", async () => {
      mockBothEndpoints({
        agents: mockSummaryResponse.agents,
        totals: {
          chat: {
            inputTokens: "500000",
            outputTokens: "700000",
            cost: "3.50",
          },
          system: {
            inputTokens: "50000",
            outputTokens: "10000",
            cost: "0.40",
          },
          plugin: {
            inputTokens: "100000",
            outputTokens: "20000",
            cost: "0.92",
          },
        },
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getByText("Chat Tokens")).toBeInTheDocument();
      });

      expect(screen.getByText("System Tokens")).toBeInTheDocument();
      expect(screen.getByText("Plugin Tokens")).toBeInTheDocument();

      // Chat: 500k + 700k = 1.2M
      expect(screen.getByText("1.2M")).toBeInTheDocument();
      // Plugin: 100k + 20k = 120k -> 120.0k
      expect(screen.getByText("120.0k")).toBeInTheDocument();
      // System: 50k + 10k = 60k -> 60.0k
      expect(screen.getByText("60.0k")).toBeInTheDocument();

      // Costs per bucket — $3.50 also appears in the Smithers agent table row
      // (getAllByText handles both occurrences). $0.40 and $0.92 are unique to
      // the source-breakdown cards.
      expect(screen.getAllByText("$3.50").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("$0.40")).toBeInTheDocument();
      expect(screen.getByText("$0.92")).toBeInTheDocument();
    });

    it("hides system card when system tokens are zero", async () => {
      mockBothEndpoints({
        agents: mockSummaryResponse.agents,
        totals: {
          chat: {
            inputTokens: "500000",
            outputTokens: "700000",
            cost: "3.50",
          },
          system: { inputTokens: "0", outputTokens: "0", cost: "0" },
          plugin: {
            inputTokens: "100000",
            outputTokens: "20000",
            cost: "0.92",
          },
        },
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getByText("Chat Tokens")).toBeInTheDocument();
      });

      expect(screen.queryByText("System Tokens")).not.toBeInTheDocument();
      expect(screen.getByText("Plugin Tokens")).toBeInTheDocument();
    });

    it("hides chat card when chat tokens are zero (same rule as system/plugin cards)", async () => {
      // The source breakdown must stay internally consistent: all three
      // cards follow the same "hide when zero" rule. Previously Chat was
      // always rendered, which created an empty placeholder for the
      // (admittedly unusual) system-only / plugin-only scenarios.
      mockBothEndpoints({
        agents: mockSummaryResponse.agents,
        totals: {
          chat: { inputTokens: "0", outputTokens: "0", cost: "0" },
          system: {
            inputTokens: "50000",
            outputTokens: "10000",
            cost: "0.40",
          },
          plugin: {
            inputTokens: "100000",
            outputTokens: "20000",
            cost: "0.92",
          },
        },
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getByText("System Tokens")).toBeInTheDocument();
      });

      expect(screen.queryByText("Chat Tokens")).not.toBeInTheDocument();
      expect(screen.getByText("Plugin Tokens")).toBeInTheDocument();
    });

    it("hides plugin card when plugin tokens are zero", async () => {
      mockBothEndpoints({
        agents: mockSummaryResponse.agents,
        totals: {
          chat: {
            inputTokens: "500000",
            outputTokens: "700000",
            cost: "3.50",
          },
          system: {
            inputTokens: "50000",
            outputTokens: "10000",
            cost: "0.40",
          },
          plugin: { inputTokens: "0", outputTokens: "0", cost: "0" },
        },
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getByText("Chat Tokens")).toBeInTheDocument();
      });

      expect(screen.getByText("System Tokens")).toBeInTheDocument();
      expect(screen.queryByText("Plugin Tokens")).not.toBeInTheDocument();
    });

    it("does not render any source cards when totals is missing from response", async () => {
      // Backward compat: summary responses without `totals` should still render
      mockBothEndpoints(mockSummaryResponse);
      render(<UsageDashboard />);

      await waitFor(() => {
        // Main summary cards still render
        expect(screen.getByText("Total Tokens")).toBeInTheDocument();
      });

      expect(screen.queryByText("Chat Tokens")).not.toBeInTheDocument();
      expect(screen.queryByText("System Tokens")).not.toBeInTheDocument();
      expect(screen.queryByText("Plugin Tokens")).not.toBeInTheDocument();
    });
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

  it("should have a mobile period dropdown that triggers re-fetch on change", async () => {
    mockBothEndpoints();
    const user = userEvent.setup();
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
    });

    const mobileSelect = screen.getByLabelText("Select time period");
    expect(mobileSelect).toBeInTheDocument();

    vi.mocked(global.fetch).mockClear();
    mockBothEndpoints();

    await user.selectOptions(mobileSelect, "7");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/summary?days=7");
      expect(global.fetch).toHaveBeenCalledWith("/api/usage/timeseries?days=7");
    });
  });

  describe("Export CSV tooltip", () => {
    it("should show 'Enterprise feature' tooltip content when not enterprise", async () => {
      mockBothEndpoints();
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      const exportBtn = screen.getByRole("button", { name: "Export CSV" });
      expect(exportBtn).toBeDisabled();

      // The tooltip trigger span gets tabIndex=0 when not enterprise, enabling focus-based tooltip open.
      // Focus the trigger to open the Radix tooltip (jsdom doesn't support hover but does support focus).
      const tooltipTrigger = exportBtn.closest("[data-slot='tooltip-trigger']")!;
      tooltipTrigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

      await waitFor(() => {
        // The tooltip content renders inside a portal with data-slot="tooltip-content"
        const tooltipContent = document.querySelector("[data-slot='tooltip-content']");
        expect(tooltipContent).toBeInTheDocument();
        expect(tooltipContent).toHaveTextContent("Enterprise feature");
      });
    });

    it("should not render 'Enterprise feature' tooltip content when enterprise", async () => {
      mockBothEndpoints(undefined, undefined, true);
      render(<UsageDashboard isEnterprise />);

      await waitFor(() => {
        expect(screen.getAllByText("Smithers").length).toBeGreaterThan(0);
      });

      const exportBtn = screen.getByRole("button", { name: "Export CSV" });
      expect(exportBtn).toBeEnabled();
      // When enterprise, the TooltipContent is not rendered at all (conditional JSX)
      expect(screen.queryByText("Enterprise feature")).not.toBeInTheDocument();
    });
  });

  describe("null cost vs $0.00", () => {
    it("displays dash when all agent costs are null", async () => {
      mockBothEndpoints({
        agents: [
          {
            agentId: "agent-1",
            agentName: "Ollama Bot",
            totalInputTokens: "100000",
            totalOutputTokens: "200000",
            totalCost: null,
          },
        ],
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Ollama Bot").length).toBeGreaterThan(0);
      });

      // The Estimated Cost card should show em dash, not "$0.00"
      const costCard = screen.getByText("Estimated Cost").closest("[data-slot='card']")!;
      expect(costCard).toHaveTextContent("\u2014");
      expect(costCard).not.toHaveTextContent("$0.00");
    });

    it("displays $0.00 when agent cost is explicitly zero", async () => {
      mockBothEndpoints({
        agents: [
          {
            agentId: "agent-1",
            agentName: "Zero Cost Bot",
            totalInputTokens: "100000",
            totalOutputTokens: "200000",
            totalCost: "0",
          },
        ],
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Zero Cost Bot").length).toBeGreaterThan(0);
      });

      const costCard = screen.getByText("Estimated Cost").closest("[data-slot='card']")!;
      expect(costCard).toHaveTextContent("$0.00");
    });

    it("displays dash for individual agent cost when null", async () => {
      mockBothEndpoints({
        agents: [
          {
            agentId: "agent-1",
            agentName: "Ollama Bot",
            totalInputTokens: "100000",
            totalOutputTokens: "200000",
            totalCost: null,
          },
          {
            agentId: "agent-2",
            agentName: "Claude Bot",
            totalInputTokens: "50000",
            totalOutputTokens: "80000",
            totalCost: "2.50",
          },
        ],
      });
      render(<UsageDashboard />);

      await waitFor(() => {
        expect(screen.getAllByText("Ollama Bot").length).toBeGreaterThan(0);
      });

      // Find the Ollama Bot row via its table cell and check the cost cell shows em dash
      const ollamaCells = screen.getAllByText("Ollama Bot");
      const ollamaCell = ollamaCells.find((el) => el.tagName === "TD")!;
      const ollamaRow = ollamaCell.closest("tr")!;
      const ollamaCostCells = ollamaRow.querySelectorAll("td");
      const ollamaCostCell = ollamaCostCells[ollamaCostCells.length - 1];
      expect(ollamaCostCell).toHaveTextContent("\u2014");
      expect(ollamaCostCell).not.toHaveTextContent("$0.00");

      // Claude Bot should still show its cost
      const claudeCells = screen.getAllByText("Claude Bot");
      const claudeCell = claudeCells.find((el) => el.tagName === "TD")!;
      const claudeRow = claudeCell.closest("tr")!;
      const claudeCostCells = claudeRow.querySelectorAll("td");
      const claudeCostCell = claudeCostCells[claudeCostCells.length - 1];
      expect(claudeCostCell).toHaveTextContent("$2.50");
    });
  });

  it("shows error message when API fetch fails", async () => {
    vi.mocked(global.fetch).mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: false }),
        } as Response);
      }
      if (urlStr.includes("/api/usage/summary")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response);
      }
      if (urlStr.includes("/api/usage/timeseries")) {
        return Promise.resolve({
          ok: true,
          json: async () => mockTimeseriesResponse,
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        json: async () => ({}),
      } as Response);
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<UsageDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("retries fetch when Retry button is clicked", async () => {
    const user = userEvent.setup();

    // First call: summary fails
    let callCount = 0;
    vi.mocked(global.fetch).mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/enterprise/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enterprise: false }),
        } as Response);
      }
      if (urlStr.includes("/api/usage/summary")) {
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({}),
          } as Response);
        }
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
      return Promise.resolve({
        ok: false,
        json: async () => ({}),
      } as Response);
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<UsageDashboard />);

    // Wait for error state
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });

    // Click retry
    await user.click(screen.getByRole("button", { name: /retry/i }));

    // After retry, data should render (agent name appears in both dropdown and data area)
    await waitFor(() => {
      expect(screen.getAllByText("Smithers").length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});
