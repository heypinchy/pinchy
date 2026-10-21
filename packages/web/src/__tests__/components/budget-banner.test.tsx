// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { BudgetBanner } from "@/components/budget-banner";
import { jsonResponse } from "@/test-helpers/fetch";

const base = { monthlyLimitUsd: 100, period: "2026-10", onExceeded: "notify" };

describe("BudgetBanner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    sessionStorage.clear();
  });
  afterEach(() => fetchSpy.mockRestore());

  function budgets(list: unknown[]) {
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse(list));
  }

  it("warns an admin once a budget passes 80%, with a way to the budgets", async () => {
    budgets([{ ...base, id: "b1", agent: null, spentUsd: 84.1, state: "warning" }]);

    render(<BudgetBanner isAdmin />);

    const bar = await screen.findByRole("alert");
    expect(bar).toHaveTextContent(
      "This Pinchy has used 84% of its monthly budget ($84.10 of $100.00)."
    );
    expect(screen.getByRole("link", { name: "Review budgets" })).toHaveAttribute("href", "/usage");
  });

  it("says chats are paused when a blocking budget is used up", async () => {
    budgets([
      {
        ...base,
        id: "b2",
        agent: { id: "a1", name: "Knowledge Base" },
        spentUsd: 101,
        onExceeded: "block",
        state: "exceeded",
      },
    ]);

    render(<BudgetBanner isAdmin />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Knowledge Base has used its monthly budget ($101.00 of $100.00). New chats and automations are paused until next month."
    );
  });

  it("shows nothing while every budget is below its warning line", async () => {
    budgets([{ ...base, id: "b1", agent: null, spentUsd: 10, state: "ok" }]);

    render(<BudgetBanner isAdmin />);

    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never asks for a member — budgets are an admin's business", () => {
    render(<BudgetBanner isAdmin={false} />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stays dismissed for this budget, month and state", async () => {
    budgets([{ ...base, id: "b1", agent: null, spentUsd: 84.1, state: "warning" }]);
    const user = userEvent.setup();

    const { unmount } = render(<BudgetBanner isAdmin />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    unmount();
    render(<BudgetBanner isAdmin />);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
