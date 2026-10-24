// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { BudgetsCard } from "@/components/budgets-card";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BUDGETS = [
  {
    id: "b-instance",
    agent: null,
    monthlyLimitUsd: 100,
    onExceeded: "notify",
    spentUsd: 84.1,
    period: "2026-10",
    state: "warning",
  },
  {
    id: "b-kb",
    agent: { id: "agent-kb", name: "Knowledge Base" },
    monthlyLimitUsd: 20,
    onExceeded: "block",
    spentUsd: 21,
    period: "2026-10",
    state: "exceeded",
  },
];
const AGENTS = [{ id: "agent-kb", name: "Knowledge Base" }];

function route(overrides: Record<string, () => Response> = {}) {
  vi.mocked(global.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    if (overrides[key]) return overrides[key]();
    if (key === "GET /api/budgets") return jsonResponse(BUDGETS);
    if (key === "GET /api/agents") return jsonResponse(AGENTS);
    return jsonResponse({ id: "ok" });
  });
}

describe("BudgetsCard", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });
  afterEach(() => fetchSpy.mockRestore());

  it("lists every budget with this month's spend against its limit", async () => {
    route();
    render(<BudgetsCard isEnterprise />);

    const instance = await screen.findByTestId("budget-b-instance");
    expect(within(instance).getByText("Whole instance")).toBeInTheDocument();
    expect(within(instance).getByText("$84.10 of $100.00 this month")).toBeInTheDocument();
    expect(within(instance).getByText(/84%/)).toBeInTheDocument();

    const kb = screen.getByTestId("budget-b-kb");
    expect(within(kb).getByText("Knowledge Base")).toBeInTheDocument();
    expect(within(kb).getByText(/chats paused/i)).toBeInTheDocument();
  });

  it("saves a budget with the typed body the route expects, then reloads the list", async () => {
    route();
    const user = userEvent.setup();
    render(<BudgetsCard isEnterprise />);
    await screen.findByTestId("budget-b-instance");

    await user.selectOptions(screen.getByLabelText("Applies to"), "agent-kb");
    await user.clear(screen.getByLabelText("Monthly limit (USD)"));
    await user.type(screen.getByLabelText("Monthly limit (USD)"), "35");
    await user.selectOptions(screen.getByLabelText("When it's used up"), "block");
    await user.click(screen.getByRole("button", { name: "Save budget" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const put = vi.mocked(global.fetch).mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/api/budgets");
    expect(JSON.parse(put[1]!.body as string)).toEqual({
      agentId: "agent-kb",
      monthlyLimitUsd: 35,
      onExceeded: "block",
    });
    const reloads = vi
      .mocked(global.fetch)
      .mock.calls.filter(([u, init]) => u === "/api/budgets" && (init?.method ?? "GET") === "GET");
    expect(reloads.length).toBeGreaterThanOrEqual(2);
  });

  it("removes a budget", async () => {
    route();
    const user = userEvent.setup();
    render(<BudgetsCard isEnterprise />);
    const kb = await screen.findByTestId("budget-b-kb");

    await user.click(within(kb).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/budgets/b-kb",
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });

  it("shows the server's refusal inline when saving fails", async () => {
    route({
      "PUT /api/budgets": () => jsonResponse({ error: "Enterprise feature" }, { status: 403 }),
    });
    const user = userEvent.setup();
    render(<BudgetsCard isEnterprise />);
    await screen.findByTestId("budget-b-instance");

    await user.type(screen.getByLabelText("Monthly limit (USD)"), "50");
    await user.click(screen.getByRole("button", { name: "Save budget" }));

    expect(await screen.findByText("Enterprise feature")).toBeInTheDocument();
  });

  it("without a license, offers no way to set a budget but still lets an admin remove one", async () => {
    route();
    render(<BudgetsCard isEnterprise={false} />);

    const kb = await screen.findByTestId("budget-b-kb");
    expect(screen.queryByRole("button", { name: "Save budget" })).not.toBeInTheDocument();
    expect(within(kb).getByRole("button", { name: "Remove" })).toBeEnabled();
  });
});
