// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApprovalCard } from "../approval-card";
import type { PendingApproval } from "@/lib/approvals/client";
import { summarizeArgs } from "@/lib/approvals/summary";

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

  // End to end from the raw call: a trailing-space "to " key used to be merged
  // over the real `to`, so the card named the boss while the tool, reading
  // `to`, mailed the attacker.
  it("shows both a key and its look-alike, labelled apart", () => {
    const params = JSON.parse(
      '{"to":"attacker@evil.com","subject":"Q3","body":"hi","to ":"boss@firma.at"}'
    );
    renderCard(summarizeArgs(params));
    expect(screen.getByText("attacker@evil.com")).toBeInTheDocument();
    expect(screen.getByText("boss@firma.at")).toBeInTheDocument();
    expect(screen.getByText("to")).toBeInTheDocument();
    expect(screen.getByText('"to "')).toBeInTheDocument();
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

  // Second review of #1242: the marker sat at the end of the stored string,
  // i.e. inside the part the 200-character preview collapses — so a value cut
  // at the stored limit looked like any long text.
  it("shows the truncation marker of a long value outside the collapsed preview", () => {
    renderCard({ body: `${"a".repeat(4000)}… [truncated: 6000 more characters not shown]` });
    expect(screen.getByRole("button", { name: /show full text/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.getByText(/truncated: 6000 more characters not shown/)).toBeInTheDocument();
  });

  // The probe of the second review: 180 blank-rendering characters pushed the
  // traversal out of the 200-character preview. Where an action lands is never
  // previewed — it is short, and it is the decision.
  it("shows a path in full, never behind a preview", () => {
    const path = `/data/reports/old-draft.md${"\u2800".repeat(180)}/../../contracts/signed.pdf`;
    renderCard(summarizeArgs({ path, content: "x" }), "pinchy_write");
    expect(screen.getByText(/\/\.\.\/\.\.\/contracts\/signed\.pdf$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
  });

  it("shows recipients in full, address first", () => {
    const to = `${"Raimund Korber Geschaeftsfuehrung ".repeat(8)}<attacker@evil.com>`;
    renderCard(summarizeArgs({ to, subject: "Rechnung" }));
    expect(screen.getByText(/^attacker@evil\.com \(name: /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
  });

  it("keeps line breaks and spaces as sent", () => {
    renderCard({ body: "Hallo,\n\n  zweite Zeile" });
    const text = screen.getByText(/zweite Zeile/);
    expect(text.textContent).toBe("Hallo,\n\n  zweite Zeile");
    expect(text).toHaveClass("whitespace-pre-wrap");
  });

  // Odoo reads bool("false") as True: the string and the boolean set opposite
  // values, so they must not render alike.
  it("tells a string that reads like a literal apart from the literal", () => {
    renderCard(
      summarizeArgs({ values: { active: "false", is_company: false, n: "1", m: 1, x: null } }),
      "odoo_write"
    );
    expect(screen.getByText('"false"')).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText('"1"')).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("null")).toBeInTheDocument();
    expect(screen.queryByText("(empty)")).not.toBeInTheDocument();
  });

  // Third review of #1242: the stored limit is 20,000 characters now (200,000
  // since the fourth review), so a long mail body is stored whole — and still
  // previewed, with all of it on demand and no truncation marker.
  it("previews a long body stored whole, and shows all of it on demand", async () => {
    const tail = "MIT-FREUNDLICHEN-GRUESSEN";
    renderCard(summarizeArgs({ body: `${"Absatz. ".repeat(1_800)}${tail}` }));
    expect(screen.queryByText(new RegExp(tail))).not.toBeInTheDocument();
    expect(screen.queryByText(/truncated/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
    expect(screen.getByText(new RegExp(tail))).toBeInTheDocument();
  });

  it("never cuts the preview between the halves of an emoji", () => {
    renderCard({ body: `a${"😀".repeat(300)}` });
    const preview = screen.getByText(/😀/);
    expect(preview.textContent).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
  });

  it("renders a CRLF mail body as line breaks, not as escaped carriage returns", () => {
    renderCard(summarizeArgs({ body: "Hallo,\r\n\r\nzweite Zeile" }));
    const text = screen.getByText(/zweite Zeile/);
    expect(text.textContent).toBe("Hallo,\n\nzweite Zeile");
  });

  it("renders a call without arguments", () => {
    renderCard(null, "pinchy_web_search");
    expect(screen.getByText("pinchy_web_search")).toBeInTheDocument();
  });

  // Fourth review of #1242: an email address or URL under a key the card
  // does not know (`values.email`, `website`) was previewed like prose, so a
  // 217-character address showed its familiar local part and cut `@evil.com`.
  it("shows an email-shaped value in full at any key, so the domain is never cut", () => {
    const email = `buchhaltung.firma.at.${"rechnungen.".repeat(17)}@evil.com`;
    expect(email).toHaveLength(217);
    renderCard(summarizeArgs({ model: "res.partner", ids: [7], values: { email } }), "odoo_write");
    expect(screen.getByText(email)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
  });

  it("shows a URL-shaped value in full, so a long userinfo cannot push the host out", () => {
    const url = `https://firma.at.${"a".repeat(250)}@evil.com/pay`;
    renderCard(summarizeArgs({ values: { website: url } }));
    expect(screen.getByText(new RegExp("@evil\\.com/pay$"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
  });

  // Postgres jsonb stores object keys sorted by length, so the summary's
  // "who and where first" order did not survive the round trip to the card.
  it("lists the recipient and target fields first, whatever order they arrive in", () => {
    renderCard({ body: "hi", subject: "Q3", values: { name: "x", model: "y" }, to: "a@b.at" });
    const labels = screen.getAllByRole("term").map((term) => term.textContent);
    expect(labels).toEqual(["to", "body", "subject", "values", "model", "name"]);
  });

  // Eleventh review of #1242: `/data/חוזים/2024.md` and `/data/2024/חוזים.md`
  // were drawn pixel-identically — no control character needed, both plain
  // paths — so an injected write was approved as the other file. The card now
  // holds every value in stored order: an LTR override around it, and each
  // right-to-left word in an isolate of its own (`inStoredOrder`).
  describe("shows right-to-left text in the order it was sent", () => {
    /** The value as drawn: override text in order, each isolated word as [word]. */
    function drawn(text: string): string {
      const override = screen
        .getAllByText((_, element) => element?.tagName === "BDO" && element.textContent === text)
        .at(0)!;
      expect(override).toHaveAttribute("dir", "ltr");
      return [...override.childNodes]
        .map((node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          const element = node as HTMLElement;
          expect(element.tagName).toBe("BDI");
          expect(element).toHaveAttribute("dir", "ltr");
          return `[${element.textContent}]`;
        })
        .join("");
    }

    it.each([
      [
        "/data/חוזים/2024.md",
        "/data/[חוזים]/2024.md",
        "/data/2024/חוזים.md",
        "/data/2024/[חוזים].md",
      ],
      ["/data/عقود/2024.md", "/data/[عقود]/2024.md", "/data/2024/عقود.md", "/data/2024/[عقود].md"],
      ["/data/א/1.md", "/data/[א]/1.md", "/data/1/א.md", "/data/1/[א].md"],
    ])("draws %s and its reordered twin apart", (a, shownA, b, shownB) => {
      renderCard(summarizeArgs({ path: a, content: "x" }), "pinchy_write");
      expect(drawn(a)).toBe(shownA);
      cleanup();
      renderCard(summarizeArgs({ path: b, content: "x" }), "pinchy_write");
      expect(drawn(b)).toBe(shownB);
    });

    // Not only where an action lands: a record name or a mail subject is
    // what the person reads too, and `חוזים 2024` drew like `2024 חוזים`.
    it("holds every value in order, at any key", () => {
      renderCard(
        summarizeArgs({ model: "res.partner", ids: [7], values: { name: "חוזים 2024" } }),
        "odoo_write"
      );
      expect(drawn("חוזים 2024")).toBe("[חוזים] 2024");
    });

    it("holds a recipient's address and name in order", () => {
      const to = '"חוזים 2024" <a@b.at>';
      renderCard(summarizeArgs({ to }));
      expect(drawn('a@b.at (name: "חוזים 2024")')).toBe('a@b.at (name: "[חוזים] 2024")');
    });

    it("holds each line of a long text in order, in the preview and in full", async () => {
      const body = `${"שורה 1\n".repeat(60)}סוף 2`;
      renderCard({ body });
      expect(screen.getAllByText((_, el) => el?.tagName === "BDO").length).toBeGreaterThan(1);
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(drawn("סוף 2")).toBe("[סוף] 2");
    });

    it("leaves text without a right-to-left character as it was", () => {
      renderCard({ subject: "Rechnung 2024 Grüße" });
      expect(screen.getByText("Rechnung 2024 Grüße").tagName).toBe("SPAN");
      expect(screen.queryAllByText((_, el) => el?.tagName === "BDO")).toEqual([]);
    });
  });

  it("still has Approve and Deny", () => {
    renderCard({ to: "a@b.c" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });
});
