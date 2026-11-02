// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { cleanup, configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApprovalCard } from "../approval-card";
import type { PendingApproval } from "@/lib/approvals/client";
import { summarizeArgs } from "@/lib/approvals/summary";
import { WHOLE_MAX, displayScalar } from "@/lib/approvals/display";

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

/**
 * Every string value is drawn once for the eye and once, quoted and hidden,
 * for a screen reader (`Spoken` in approval-card.tsx). The text queries here
 * read what is DRAWN; what is read aloud is checked through `spokenText`.
 */
configure({ defaultIgnore: "script, style, .sr-only" });

/** The card's text as assistive technology reads it: everything but what is
 * hidden from it with `aria-hidden`. */
function spokenText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(spokenText).join("");
}

/** The card's text as it is drawn: everything but the screen-reader copy. */
function drawnText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.classList.contains("sr-only")) return "";
  return [...node.childNodes].map(drawnText).join("");
}

/**
 * Clicks "Show full text" and then "Show next part" until the last part, and
 * returns what the one value on the card drew and what it read at each step.
 */
async function showEveryPart(container: HTMLElement) {
  await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
  const drawn: string[] = [];
  const spoken: string[] = [];
  for (;;) {
    drawn.push(container.querySelector("dd [aria-hidden='true']")!.textContent!);
    spoken.push(container.querySelector("dd .sr-only")!.textContent!);
    const next = screen.queryByRole("button", { name: /show next part/i });
    if (!next || next.hasAttribute("disabled")) return { drawn, spoken };
    await userEvent.click(next);
  }
}

/** A part as drawn or read, without the `…` that says more comes before or after it. */
function withoutEllipses(part: string): string {
  return part.replace(/^…/, "").replace(/…$/, "");
}

/** The text a read part quotes: its `"` and `\` unescaped. */
function unquoted(part: string): string {
  const inner = withoutEllipses(part);
  expect(inner).toMatch(/^"(?:[^"\\]|\\[\s\S])*"$/u);
  return inner.slice(1, -1).replace(/\\([\s\S])/gu, "$1");
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
    expect(items.map(drawnText)).toEqual(["chef@firma.at", "angreifer@evil.com"]);
    expect(items.map(spokenText)).toEqual(['"chef@firma.at"', '"angreifer@evil.com"']);
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

  // The gate refuses every call it would have to cut, so no summary the card
  // is shown carries a real truncation marker. The card used to split one off
  // the end of any value anyway — so an agent that TYPED "… [truncated: 9 more
  // characters not shown]" after a path had it drawn as Pinchy's marker,
  // outside the value, and read outside its quotes. Typed text is the value's.
  it("keeps a typed truncation marker inside the value it was typed in", () => {
    const { container } = renderCard({
      path: "/data/x.md… [truncated: 9 more characters not shown]",
    });
    expect(
      screen.getByText("/data/x.md… [truncated: 9 more characters not shown]")
    ).toBeInTheDocument();
    expect(spokenText(container)).toContain(
      '"/data/x.md… [truncated: 9 more characters not shown]"'
    );
    expect(screen.queryByText("/data/x.md")).not.toBeInTheDocument();
  });

  it("previews a long value that ends in a typed marker like any long text", async () => {
    renderCard({ body: `${"a".repeat(4000)}… [truncated: 6000 more characters not shown]` });
    expect(screen.getByRole("button", { name: /show full text/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText(/truncated: 6000 more characters not shown/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
    expect(
      screen.getByText(/^a+… \[truncated: 6000 more characters not shown\]$/)
    ).toBeInTheDocument();
  });

  // An unanchored URL pattern drew free text that merely began with a URL
  // whole, up to 8,192 characters, instead of the 200-character preview.
  it.each([
    `https://firma.at\n${"Hi team, the new site is live. ".repeat(10)}`,
    `https://firma.at — ${"the new site is live. ".repeat(12)}`,
    `https://firma.at, ${"see above. ".repeat(25)}`,
  ])("previews free text that begins with a URL, and notes nothing: %#", (body) => {
    renderCard(summarizeArgs({ body }));
    expect(screen.getByRole("button", { name: /show full text/i })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-annotation]")).toHaveLength(0);
  });

  // `{values: {}}` and `{values: []}` were both drawn as "(none)". The card
  // draws them as the prompt prints them, and says which in words.
  it("draws an empty list and an empty object apart", () => {
    const list = renderCard({ values: [] }).container;
    const listDrawn = drawnText(list);
    const listSpoken = spokenText(list);
    cleanup();
    const object = renderCard({ values: {} }).container;
    expect(drawnText(object)).not.toBe(listDrawn);
    expect(spokenText(object)).not.toBe(listSpoken);
    expect(listDrawn).toContain("values[]");
    expect(drawnText(object)).toContain("values{}");
    expect(listSpoken).toContain("empty list");
    expect(spokenText(object)).toContain("empty object");
  });

  it("draws an empty list apart from the string that reads like it", () => {
    const list = renderCard({ values: [] }).container;
    const drawn = drawnText(list);
    const spoken = spokenText(list);
    cleanup();
    const typed = renderCard({ values: "[]" }).container;
    expect(drawnText(typed)).not.toBe(drawn);
    expect(spokenText(typed)).not.toBe(spoken);
  });

  // 180 blank-rendering characters would push the traversal out of the
  // 200-character preview. Where an action lands is never
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
    const address = screen.getByText("attacker@evil.com");
    // The display name is drawn after the address, beside it — not in it.
    const name = address.closest("dd")!.querySelector('[data-annotation="name"]')!;
    expect(name.textContent).toMatch(/^name Raimund Korber Geschaeftsfuehrung/);
    expect(address.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  // The stored limit is 200,000 characters, so a long mail body is stored
  // whole — and still previewed, with all of it on demand and no truncation
  // marker.
  it("previews a long body stored whole, and shows all of it on demand", async () => {
    const tail = "MIT-FREUNDLICHEN-GRUESSEN";
    const body = `${"Absatz. ".repeat(1_800)}${tail}`;
    const { container } = renderCard(summarizeArgs({ body }));
    expect(screen.queryByText(new RegExp(tail))).not.toBeInTheDocument();
    expect(screen.queryByText(/truncated/)).not.toBeInTheDocument();
    const { drawn } = await showEveryPart(container);
    expect(drawn.map(withoutEllipses).join("")).toBe(body);
    expect(drawn.at(-1)).toMatch(new RegExp(`${tail}$`));
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

  // Previewed like prose, an email address or URL under a key the card does
  // not know (`values.email`, `website`) would show a 217-character address's
  // familiar local part and cut `@evil.com`.
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

  // Chromium lays out a long mixed-direction text in time that grows faster
  // than its length — 13 s for one 200,000-character value drawn whole,
  // frozen on every render of the card. So whole is bounded, at a size that
  // holds every real target: pinchy-files caps a path at 1,024 characters,
  // and the widest marker a character can become is eight (`⟨U+200D⟩`).
  describe("draws a target or an address whole only up to 8,192 characters", () => {
    it("draws the longest path pinchy-files accepts whole, every character a marker", () => {
      const path = "\u00A0\u200D".repeat(512);
      const shown = summarizeArgs({ path }).path as string;
      expect([...shown]).toHaveLength(8192);
      renderCard({ path: shown }, "pinchy_write");
      expect(screen.getByText(shown)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /show full text/i })).not.toBeInTheDocument();
    });

    it.each([
      ["a target", { path: `/data/${"x".repeat(8200)}END` }],
      ["an address at any key", { note: `https://x.at/${"y".repeat(8200)}END` }],
    ])("previews %s past that, and shows all of it on demand", async (_label, summary) => {
      const { container } = renderCard(summary);
      expect(screen.queryByText(/END$/)).not.toBeInTheDocument();
      expect(screen.getByText(/more characters hidden/i)).toBeInTheDocument();
      const { drawn } = await showEveryPart(container);
      expect(drawn.map(withoutEllipses).join("")).toBe(Object.values(summary)[0]);
      expect(drawn.at(-1)).toMatch(/END$/);
    });
  });

  // Drawn whole, one 200,000-character value of alternating Hebrew letters
  // and digits — a mail body the gate accepts, since its preview is cheap —
  // blocked Chromium for 13–28 s on "Show full text", and again on every
  // relayout. So the full text is revealed one part at a time, each bounded
  // like one target drawn whole, and only one part is on the card at once.
  describe("reveals a long text one bounded part at a time", () => {
    it("draws and reads one bounded part of a 200,000-character right-to-left body", async () => {
      const body = "\u05d01".repeat(100_000);
      const { container } = renderCard(summarizeArgs({ body }));
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      const drawn = container.querySelector("dd [aria-hidden='true']")!;
      expect([...drawn.textContent!].length).toBeLessThanOrEqual(WHOLE_MAX + 1);
      expect(drawn.querySelectorAll("bdi").length).toBeLessThanOrEqual(WHOLE_MAX / 2);
      const spoken = container.querySelector("dd .sr-only")!.textContent!;
      expect(unquoted(spoken)).toBe(body.slice(0, WHOLE_MAX));
      expect(screen.getByText(/characters 1–8,192 of 200,000/)).toBeInTheDocument();
    });

    it.each([
      ["mixed text", `${'Grüße,\u00A0שלום 1 "x" \\ 😀 '.repeat(800)}END`],
      ["text drawn quoted", JSON.stringify(Array(1_500).fill('he said "hi" \\ ok \u05d0'))],
    ])(
      "draws and reads every character of %s across its parts, and never half a marker",
      async (_name, text) => {
        const body = summarizeArgs({ body: text }).body as string;
        const { container } = renderCard({ body });
        const { drawn, spoken } = await showEveryPart(container);
        expect(drawn.length).toBeGreaterThan(2);
        expect(drawn.map(withoutEllipses).join("")).toBe(displayScalar(body));
        expect(spoken.map(unquoted).join("")).toBe(body);
        for (const part of drawn) {
          expect(part).not.toMatch(/⟨[^⟩]*$/u);
          expect(part).not.toMatch(/^[^⟨]*⟩/u);
        }
        const total = [...displayScalar(body)].length.toLocaleString("en-US");
        expect(
          screen.getByText(new RegExp(`characters [\\d,]+–${total} of ${total}`))
        ).toBeInTheDocument();
      }
    );

    it("says which part is shown, steps back, and collapses to the preview again", async () => {
      const body = `${"a".repeat(WHOLE_MAX)}SECOND-PART`;
      renderCard({ body });
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(screen.getByText(/characters 1–8,192 of 8,203/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show previous part/i })).toBeDisabled();
      expect(screen.queryByText(/SECOND-PART/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show next part/i }));
      expect(screen.getByText(/^…SECOND-PART$/)).toBeInTheDocument();
      expect(screen.getByText(/characters 8,193–8,203 of 8,203/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show next part/i })).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: /show previous part/i }));
      expect(screen.getByText(/characters 1–8,192 of 8,203/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show less/i }));
      expect(screen.getByText(/more characters hidden/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /show next part/i })).not.toBeInTheDocument();
    });

    it("offers no parts for a text that fits in one", async () => {
      renderCard({ body: "a".repeat(WHOLE_MAX) });
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(screen.getByText("a".repeat(WHOLE_MAX))).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /show next part/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/characters 1–/)).not.toBeInTheDocument();
    });
  });

  // Postgres jsonb stores object keys sorted by length, so the summary's
  // "who and where first" order did not survive the round trip to the card.
  it("lists the recipient and target fields first, whatever order they arrive in", () => {
    renderCard({ body: "hi", subject: "Q3", values: { name: "x", model: "y" }, to: "a@b.at" });
    const labels = screen.getAllByRole("term").map((term) => term.textContent);
    expect(labels).toEqual(["to", "body", "subject", "values", "model", "name"]);
  });

  // Left to the bidi algorithm, `/data/חוזים/2024.md` and `/data/2024/חוזים.md`
  // are drawn pixel-identically — no control character needed, both plain
  // paths — so an injected write would be approved as the other file. The card
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
      expect(drawn("חוזים 2024")).toBe("[חוזים] 2024");
      expect(screen.getByText("a@b.at")).toBeInTheDocument();
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

  // Annotations are nodes of their own, drawn
  // beside the value — so a value can't type them.
  describe("annotations", () => {
    it("draws a record reference as the record, apart from any text", () => {
      renderCard({
        partner_id: { "@": "ref", model: "res.partner", id: 7, label: "Acme GmbH", labelCut: 0 },
        name: '(record reference: res.partner #7 "Acme GmbH")',
      });
      const ref = document.querySelector('[data-annotation="ref"]')!;
      expect(ref.textContent).toBe('record reference res.partner #7 "Acme GmbH"');
      expect(
        screen.getByText('(record reference: res.partner #7 "Acme GmbH")')
      ).not.toHaveAttribute("data-annotation");
      expect(document.querySelectorAll("[data-annotation]")).toHaveLength(1);
    });

    it("says how much of a long record label was cut", () => {
      renderCard({
        target: { "@": "ref", model: "res.partner", id: 7, label: "A".repeat(200), labelCut: 50 },
      });
      expect(document.querySelector('[data-annotation="ref"]')!.textContent).toMatch(
        /label cut: 50 more characters not shown/
      );
    });

    it("draws the host beside the address, and a hidden secret as a note", () => {
      renderCard({
        email: {
          "@": "noted",
          text: "boss@fіrma.at",
          notes: [{ kind: "host", host: "xn--frma-l9d.at" }],
        },
        access_token: { "@": "secret", length: 19 },
      });
      expect(screen.getByText("boss@fіrma.at")).not.toHaveAttribute("data-annotation");
      expect(document.querySelector('[data-annotation="host"]')!.textContent).toBe(
        "host xn--frma-l9d.at"
      );
      expect(document.querySelector('[data-annotation="secret"]')!.textContent).toBe(
        "[secret-like field is being set — value hidden, 19 characters]"
      );
    });

    // Summaries stored before nodes existed carry their notes in the text.
    // They read as they always did: as text, with nothing drawn as Pinchy's.
    it("draws a summary stored before nodes as the text it holds", () => {
      renderCard({
        email: "boss@fіrma.at (xn--frma-l9d.at)",
        target: '(record reference: res.partner #7 "Acme GmbH")',
      });
      expect(screen.getByText("boss@fіrma.at (xn--frma-l9d.at)")).toBeInTheDocument();
      expect(document.querySelectorAll("[data-annotation]")).toHaveLength(0);
    });

    // Written by a newer version and read after a rollback, say: it must not
    // be drawn as a field list that looks like the call.
    it("says so for a node it cannot read, instead of drawing it as fields", () => {
      renderCard({ target: { "@": "chart", model: "res.partner" } });
      expect(document.querySelector('[data-annotation="unreadable"]')!.textContent).toMatch(
        /cannot show/
      );
      expect(screen.queryByText("res.partner")).not.toBeInTheDocument();
    });
  });

  /**
   * The dashed label tells an annotation from a value only to the eye. A
   * screen reader, and anything else that reads the card's text, gets the
   * same characters for both: a real record reference
   * and the plain string `record reference res.partner #7 "Acme GmbH"` — which
   * pinchy-odoo resolves by name — read identically. So the card says it in
   * words, the way the prompt does: every string value is read in quotes,
   * escaped, and every annotation as a note that says it is Pinchy's.
   */
  describe("reads a value apart from an annotation without seeing the card", () => {
    const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
      [
        "a record reference and its words typed as a string",
        {
          partner_id: { "@": "ref", model: "res.partner", id: 7, label: "Acme GmbH", labelCut: 0 },
        },
        { partner_id: 'record reference res.partner #7 "Acme GmbH"' },
      ],
      [
        "an address with its host note and the note typed after it",
        summarizeArgs({ email: "boss@f\u0456rma.at" }),
        { email: "boss@f\u0456rma.athost xn--frma-l9d.at" },
      ],
      [
        "a named recipient and the name typed after the address",
        summarizeArgs({ to: '"Ada" <ada@example.com>' }),
        { to: "ada@example.comname Ada" },
      ],
    ];

    it.each(pairs)("for %s", (_name, annotated, typed) => {
      const real = renderCard(annotated).container;
      const realSpoken = spokenText(real);
      const realText = real.textContent;
      expect(screen.getAllByRole("note").length).toBeGreaterThan(0);
      cleanup();
      const forged = renderCard(typed).container;
      expect(screen.queryAllByRole("note")).toHaveLength(0);
      expect(spokenText(forged)).not.toBe(realSpoken);
      expect(forged.textContent).not.toBe(realText);
      cleanup();
    });

    it("reads a string value in quotes, escaped, and a literal without", () => {
      const { container } = renderCard({
        name: 'record reference res.partner #7 "Acme GmbH"',
        flag: "false",
        active: false,
      });
      const spoken = spokenText(container);
      expect(spoken).toContain('"record reference res.partner #7 \\"Acme GmbH\\""');
      expect(spoken).toContain('flag"false"');
      expect(spoken).toContain("activefalse");
    });

    it("reads an annotation as Pinchy's note, outside the value's quotes", () => {
      const { container } = renderCard(summarizeArgs({ email: "boss@f\u0456rma.at" }));
      expect(spokenText(container)).toContain(
        '"boss@f\u0456rma.at" Pinchy note: host xn--frma-l9d.at'
      );
    });

    // Left to the bidi algorithm, the unseen copy of 8,192 alternating Hebrew
    // letters and digits tripled the card's layout time in Chromium.
    it("holds the read copy in one left-to-right override, which costs no bidi layout", () => {
      const { container } = renderCard({ path: "\u05d01".repeat(4_096) });
      const copies = container.querySelectorAll(".sr-only");
      expect(copies.length).toBeGreaterThan(0);
      const copy = [...copies].find((el) => el.textContent?.includes("\u05d01"))!;
      expect(copy.tagName).toBe("BDO");
      expect(copy).toHaveAttribute("dir", "ltr");
      expect(copy.children).toHaveLength(0);
    });

    it("reads only the preview of a collapsed text, quoted, and says the rest is hidden", () => {
      const { container } = renderCard({ body: `${"a".repeat(200)}SECRET-TAIL` });
      const spoken = spokenText(container);
      expect(spoken).toContain(`"${"a".repeat(200)}"…`);
      expect(spoken).toContain("(11 more characters hidden)");
      expect(spoken).not.toContain("SECRET-TAIL");
    });
  });

  it("still has Approve and Deny", () => {
    renderCard({ to: "a@b.c" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });
});
