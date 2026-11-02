// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApprovalCard } from "../approval-card";
import type { PendingApproval } from "@/lib/approvals/client";

function approval(argsSummary: Record<string, unknown> | null, toolName = "email_send") {
  return {
    id: "req-1",
    agentId: "a1",
    agentName: "Smithers",
    toolName,
    argsSummary,
    sessionKey: "agent:a1:direct:u",
    createdAt: "",
    expiresAt: "",
  } satisfies PendingApproval;
}

function renderCard(argsSummary: Record<string, unknown> | null, toolName?: string) {
  return render(
    <ApprovalCard approval={approval(argsSummary, toolName)} busy={false} onDecide={vi.fn()} />
  );
}

/**
 * The card is the only thing between a prompt-injected agent and an action the
 * person never meant. It must render what will run — every recipient, every
 * value — and be honest about anything it shortens.
 */
describe("ApprovalCard shows what will actually run", () => {
  it("names the agent, the tool and its arguments", () => {
    renderCard({ subject: "Invoice" });
    expect(screen.getByText(/Smithers needs your confirmation/)).toBeInTheDocument();
    expect(screen.getByText("email_send")).toBeInTheDocument();
    expect(screen.getByText("subject")).toBeInTheDocument();
    expect(screen.getByText("Invoice")).toBeInTheDocument();
  });

  it("lists each recipient on its own line, so a second address cannot hide in the first", () => {
    renderCard({ to: ["chef@firma.at", "angreifer@evil.com"] });
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["chef@firma.at", "angreifer@evil.com"]);
  });

  it("shows the ids and values of an object argument, not a count", () => {
    renderCard(
      { model: "res.partner.bank", ids: [42], values: { acc_number: "AT61 1904", amount: 99999 } },
      "odoo_write"
    );
    expect(screen.getByText("acc_number")).toBeInTheDocument();
    expect(screen.getByText("AT61 1904")).toBeInTheDocument();
    expect(screen.getByText("99999")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText(/\{\d+ fields?\}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[\d+ items?\]/)).not.toBeInTheDocument();
  });

  it("shows a long text as a preview that says it is shortened, and reveals all of it on demand", async () => {
    const tail = "THE-END-OF-THE-BODY";
    const body = `${"word ".repeat(100)}${tail}`;
    renderCard({ body });

    expect(screen.queryByText(new RegExp(tail))).not.toBeInTheDocument();
    expect(screen.getByText(/more characters hidden/i)).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /show full text/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);

    expect(screen.getByText(new RegExp(tail))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show less/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("does not offer to expand a short text", () => {
    renderCard({ subject: "Invoice" });
    expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
  });

  it("keeps the truncation marker of the stored summary visible", () => {
    renderCard({ body: "abc… [truncated: 812 more characters not shown]" });
    expect(screen.getByText(/truncated: 812 more characters not shown/)).toBeInTheDocument();
  });

  it("renders a call without arguments", () => {
    renderCard(null, "pinchy_web_search");
    expect(screen.getByText("pinchy_web_search")).toBeInTheDocument();
  });

  it("still has Approve and Deny", () => {
    renderCard({ to: "a@b.c" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });
});
