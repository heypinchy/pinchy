// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ARM_MS, ApprovalCard } from "../approval-card";
import type { PendingApproval } from "@/lib/approvals/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeCall } from "@/lib/approvals/summary";
import { summarizeArgs } from "@/test-helpers/approvals";
import { PREVIEW_LEN, WHOLE_MAX, displayScalar, textOf, type Shown } from "@/lib/approvals/display";

/**
 * A tool the card has no preview for, so every value is drawn once, in the
 * field list. The value-rendering tests below use it; the previews have their
 * own tests at the end of this file.
 */
const GENERIC_TOOL = "pinchy_save_user_context";

function approval(argsSummary: Record<string, unknown> | null, toolName = GENERIC_TOOL) {
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
    if (!next || next.getAttribute("aria-disabled") === "true") return { drawn, spoken };
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
  it("names the agent, what the call does and its arguments", () => {
    renderCard({ subject: "Invoice" });
    expect(screen.getByText(/Smithers needs your confirmation/)).toBeInTheDocument();
    expect(screen.getByText(GENERIC_TOOL)).toBeInTheDocument();
    expect(screen.getByText("Subject")).toBeInTheDocument();
    expect(screen.getByText("Invoice")).toBeInTheDocument();
  });

  it("lists each recipient on its own line, so a second address cannot hide in the first", () => {
    renderCard({ to: ["chef@firma.at", "angreifer@evil.com"] });
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map(drawnText)).toEqual(["chef@firma.at", "angreifer@evil.com"]);
    expect(items.map(spokenText)).toEqual(['"chef@firma.at"', '"angreifer@evil.com"']);
  });

  // End to end from the raw call: merged over the real `to`, a trailing-space
  // "to " key would make the card name the boss while the tool, reading `to`,
  // mailed the attacker.
  it("shows both a key and its look-alike, labelled apart", () => {
    const params = JSON.parse(
      '{"to":"attacker@evil.com","subject":"Q3","body":"hi","to ":"boss@firma.at"}'
    );
    renderCard(summarizeArgs(params));
    expect(screen.getByText("attacker@evil.com")).toBeInTheDocument();
    expect(screen.getByText("boss@firma.at")).toBeInTheDocument();
    expect(screen.getByText("To")).toBeInTheDocument();
    expect(screen.getByText('"to "')).toBeInTheDocument();
  });

  it("shows the ids and values of an object argument, not a count", () => {
    renderCard(
      { model: "res.partner.bank", ids: [42], values: { acc_number: "AT61 1904", amount: 99999 } },
      "odoo_write"
    );
    expect(screen.getByText("Acc number")).toBeInTheDocument();
    expect(screen.getByText("AT61 1904")).toBeInTheDocument();
    expect(screen.getByText("99999")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText(/\{\d+ fields?\}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[\d+ items?\]/)).not.toBeInTheDocument();
  });

  it("shows a long text as a preview that says it is shortened, and reveals all of it on demand", async () => {
    const tail = "THE-END-OF-THE-BODY";
    const body = `${"word ".repeat(100)}${tail}`;
    renderCard(summarizeArgs({ body }));

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
  // is shown carries a real truncation marker. A card that split one off the
  // end of any value anyway would draw an agent's TYPED "… [truncated: 9 more
  // characters not shown]" after a path as Pinchy's marker, outside the value,
  // and read it outside its quotes. Typed text is the value's.
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
    renderCard(
      summarizeArgs({ body: `${"a".repeat(4000)}… [truncated: 6000 more characters not shown]` })
    );
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
    expect(listDrawn).toContain("Values[]");
    expect(drawnText(object)).toContain("Values{}");
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
    // In the sentence, and under "File".
    expect(screen.getAllByText(/\/\.\.\/\.\.\/contracts\/signed\.pdf$/)).toHaveLength(2);
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
    renderCard(summarizeArgs({ body: `a${"😀".repeat(300)}` }));
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
    expect(screen.getByText("Search the web")).toBeInTheDocument();
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
    ])("previews %s past that, and shows all of it on demand", async (_label, params) => {
      const { container } = renderCard(summarizeArgs(params));
      expect(screen.queryByText(/END$/)).not.toBeInTheDocument();
      expect(screen.getByText(/more characters hidden/i)).toBeInTheDocument();
      const { drawn } = await showEveryPart(container);
      expect(drawn.map(withoutEllipses).join("")).toBe(Object.values(params)[0]);
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
        const { body } = summarizeArgs({ body: text });
        const { container } = renderCard({ body });
        const stored = textOf(body as Shown);
        const { drawn, spoken } = await showEveryPart(container);
        expect(drawn.length).toBeGreaterThan(2);
        expect(drawn.map(withoutEllipses).join("")).toBe(displayScalar(stored));
        expect(spoken.map(unquoted).join("")).toBe(stored);
        for (const part of drawn) {
          expect(part).not.toMatch(/⟨[^⟩]*$/u);
          expect(part).not.toMatch(/^[^⟨]*⟩/u);
        }
        const total = [...displayScalar(stored)].length.toLocaleString("en-US");
        expect(
          screen.getByText(new RegExp(`characters [\\d,]+–${total} of ${total}`))
        ).toBeInTheDocument();
      }
    );

    it("says which part is shown, steps back, and collapses to the preview again", async () => {
      const body = `${"a".repeat(WHOLE_MAX)}SECOND-PART`;
      renderCard(summarizeArgs({ body }));
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(screen.getByText(/characters 1–8,192 of 8,203/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show previous part/i })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      expect(screen.queryByText(/SECOND-PART/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show next part/i }));
      expect(screen.getByText(/^…SECOND-PART$/)).toBeInTheDocument();
      expect(screen.getByText(/characters 8,193–8,203 of 8,203/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show next part/i })).toHaveAttribute(
        "aria-disabled",
        "true"
      );

      await userEvent.click(screen.getByRole("button", { name: /show previous part/i }));
      expect(screen.getByText(/characters 1–8,192 of 8,203/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show less/i }));
      expect(screen.getByText(/more characters hidden/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /show next part/i })).not.toBeInTheDocument();
    });

    // A keyboard or screen-reader user steps with Enter. A truly disabled
    // button drops focus to the page the moment it is reached, so the end
    // buttons stay focusable and simply do nothing.
    it("keeps focus on the step button at the first and last part", async () => {
      const body = `${"a".repeat(WHOLE_MAX)}SECOND-PART`;
      renderCard(summarizeArgs({ body }));
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      const next = screen.getByRole("button", { name: /show next part/i });
      next.focus();
      await userEvent.keyboard("{Enter}");
      const last = screen.getByRole("button", { name: /show next part/i });
      expect(last).not.toBeDisabled();
      expect(last).toHaveAttribute("aria-disabled", "true");
      expect(last).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByText(/characters 8,193–8,203 of 8,203/)).toBeInTheDocument();
      const previous = screen.getByRole("button", { name: /show previous part/i });
      previous.focus();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: /show previous part/i })).not.toBeDisabled();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByText(/characters 1–8,192 of 8,203/)).toBeInTheDocument();
    });

    // One character can cost more than a part — a letter under 9,000 accents
    // — and is then split. Its two pieces draw differently than the whole
    // character, so the card says where that happens.
    it("says when a part ends or starts inside a character too long for one part", async () => {
      renderCard(summarizeArgs({ body: `a${"\u0301".repeat(9_000)} ok` }));
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(
        screen.getByText(/the last character shown may go on in the next part/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/may begin in the previous part/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /show next part/i }));
      expect(
        screen.getByText(/the first character shown may begin in the previous part/)
      ).toBeInTheDocument();
    });

    // A character longer than the preview — a letter under 300 accents — is
    // cut inside it, like a part, and the preview says so as a part does.
    it("says when the preview ends inside a character longer than it", () => {
      renderCard(summarizeArgs({ body: `a${"́".repeat(300)} ok` }));
      expect(
        screen.getByText(/the last character shown may go on past the preview/)
      ).toBeInTheDocument();
    });

    it("says nothing about characters where the preview ends between two of them", () => {
      renderCard(summarizeArgs({ body: `${"a".repeat(200)}SECRET-TAIL` }));
      expect(screen.queryByText(/may go on past the preview/)).not.toBeInTheDocument();
    });

    it("says nothing about characters where a part ends between two of them", async () => {
      renderCard(summarizeArgs({ body: `${"a".repeat(WHOLE_MAX)}SECOND-PART` }));
      await userEvent.click(screen.getByRole("button", { name: /show full text/i }));
      expect(screen.queryByText(/may go on in the next part/)).not.toBeInTheDocument();
    });

    it("offers no parts for a text that fits in one", async () => {
      renderCard(summarizeArgs({ body: "a".repeat(WHOLE_MAX) }));
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
    expect(labels).toEqual(["To", "Body", "Subject", "Values", "Model", "Name"]);
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
      renderCard(summarizeArgs({ body }));
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
      expect(spoken).toContain('Flag"false"');
      expect(spoken).toContain("Activefalse");
    });

    it("reads an annotation as Pinchy's note, outside the value's quotes", () => {
      const { container } = renderCard(summarizeArgs({ email: "boss@f\u0456rma.at" }));
      expect(spokenText(container)).toContain(
        '"boss@f\u0456rma.at" Pinchy note: host xn--frma-l9d.at'
      );
    });

    it("reads a host that is not a valid domain name as Pinchy's note, naming the host", () => {
      const { container } = renderCard(
        summarizeArgs({ website: `https://www.firma.at.${"a".repeat(250)}@xn--a.evil.com/x y` })
      );
      expect(spokenText(container)).toContain(
        'Pinchy note: host "xn--a.evil.com", not a valid domain name'
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

    // Cut by code point, the preview of "Café" ended "Cafe": a letter the
    // value does not contain there.
    it("previews a text up to a character boundary, and counts what it hides from there", () => {
      const { container } = renderCard(
        summarizeArgs({ body: `${"x".repeat(199)}e\u0301${"y".repeat(100)}` })
      );
      const spoken = spokenText(container);
      expect(spoken).toContain(`"${"x".repeat(199)}"…`);
      expect(spoken).toContain("(102 more characters hidden)");
    });

    it("reads only the preview of a collapsed text, quoted, and says the rest is hidden", () => {
      const { container } = renderCard(summarizeArgs({ body: `${"a".repeat(200)}SECRET-TAIL` }));
      const spoken = spokenText(container);
      expect(spoken).toContain(`"${"a".repeat(200)}"…`);
      expect(spoken).toContain("(11 more characters hidden)");
      expect(spoken).not.toContain("SECRET-TAIL");
    });
  });

  /**
   * Whether a value is drawn whole or previewed, where the preview ends, and
   * where each part of "Show full text" ends are decided once, by the summary,
   * which charges the draw budget for exactly that. Asked again in the
   * approver's browser, every difference between its URL parser or its
   * Intl.Segmenter and the server's would be a card that draws more than it
   * was charged: Chromium and WebKit accept a host such as `xn--a` that Node
   * refuses, so sixty values priced as previews would be drawn whole, 8,000
   * characters of right-to-left text each, and the card would take seconds to
   * appear. The card reads every decision from the stored summary.
   */
  describe("draws what the summary decided, whatever the browser", () => {
    /** A URL parser that accepts the invalid punycode labels Node refuses, as Chromium's does. */
    class LenientURL extends URL {
      constructor(input: string | URL, base?: string | URL) {
        try {
          super(input, base);
        } catch {
          super(String(input).replace(/xn--[^./:]*/giu, "xn--zca"), base);
        }
      }
    }

    function inBrowser(stub: () => void, draw: () => void) {
      stub();
      try {
        draw();
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it("previews a URL the server's parser refuses, though the browser's accepts it", () => {
      const value = `https://xn--a.com/${"a".repeat(180)}${"א1".repeat(3_995)}`;
      const values = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, value]));
      const { summary, exceeded } = summarizeCall({ model: "res.partner", ids: [7], values });
      expect(exceeded).toBeNull();
      inBrowser(
        () => vi.stubGlobal("URL", LenientURL),
        () => {
          const { container } = renderCard(summary, "odoo_write");
          const drawn = [...container.querySelectorAll("dd dd [aria-hidden='true']")];
          expect(drawn).toHaveLength(60);
          for (const value of drawn) {
            expect([...value.textContent!].length).toBeLessThanOrEqual(PREVIEW_LEN + 1);
          }
          expect(screen.getAllByRole("button", { name: /show full text/i })).toHaveLength(60);
        }
      );
    });

    it("cuts a preview and its parts where the summary did, without Intl.Segmenter too", async () => {
      const body = summarizeArgs({ body: `${"x".repeat(199)}é${"🇦🇹".repeat(200)}` }).body;
      const withSegmenter = render(
        <ApprovalCard approval={approval({ body })} busy={false} onDecide={vi.fn()} />
      );
      const preview = drawnText(withSegmenter.container);
      const parts = (await showEveryPart(withSegmenter.container)).drawn;
      cleanup();
      vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
      try {
        const { container } = renderCard({ body });
        expect(drawnText(container)).toBe(preview);
        expect((await showEveryPart(container)).drawn).toEqual(parts);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // The read copy is cut where the drawn one is: a text that reads as a
    // JSON literal is drawn escaped, so the same stretch of it is drawn in
    // more characters than it is read in.
    it("reads exactly the stretch of a quote-dense text it draws", () => {
      const body = summarizeArgs({ body: `[${Array(100).fill('"😀"').join(",")}]` }).body;
      const { container } = renderCard({ body });
      const drawn = container.querySelector("dd [aria-hidden='true']")!.textContent!;
      const spoken = container.querySelector("dd .sr-only")!.textContent!;
      expect(drawn.endsWith("…")).toBe(true);
      expect(JSON.stringify(unquoted(spoken)).slice(0, -1)).toBe(withoutEllipses(drawn));
      const emoji = (text: string) => [...text].filter((c) => c === "😀").length;
      expect(emoji(spoken)).toBe(emoji(drawn));
    });

    // A summary the card cannot read every decision from is not guessed at:
    // the approver is told to deny.
    it.each([
      [
        "a previewed text without its parts",
        { "@": "previewed", text: "a".repeat(300), preview: 200 },
      ],
      [
        "a previewed text whose parts do not reach its end",
        { "@": "previewed", text: "a".repeat(300), preview: 200, parts: [250], inside: [] },
      ],
      ["a plain text longer than any text is drawn whole", "a".repeat(WHOLE_MAX + 1)],
    ])("says it cannot show %s", (_name, value) => {
      renderCard({ body: value });
      expect(document.querySelector('[data-annotation="unreadable"]')).not.toBeNull();
      expect(screen.queryByText(/a{200}/)).not.toBeInTheDocument();
    });

    it("contains no parsing or segmentation that differs between browsers", () => {
      for (const file of [
        "../approval-card.tsx",
        "../../lib/approvals/display.ts",
        "../../lib/approvals/intent.ts",
      ]) {
        const code = readFileSync(resolve(import.meta.dirname, file), "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        expect(code, file).not.toMatch(/new URL\b|URL\.(parse|canParse)|Intl\.Segmenter/);
      }
    });
  });

  it("still has Approve and Deny", () => {
    renderCard({ to: "a@b.c" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });
});

/** Whether `button` acts when pressed — it stays in the tab order either way. */
function offered(button: HTMLElement) {
  return button.getAttribute("aria-disabled") !== "true";
}

/**
 * A card opens where the person clicked: in the corner the stack is anchored
 * to the bottom, so a card that opens grows upward and its Approve lands on
 * the pixels its Review button just held. The second click of a double click
 * on Review must not approve what it has not shown yet.
 */
describe("opening a card", () => {
  const pending = approval({ to: "a@b.c" });

  /** A card the test opens the way the person does — with Review. */
  function Reviewable({ onDecide }: { onDecide: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <ApprovalCard
        approval={pending}
        busy={false}
        open={open}
        onOpen={() => setOpen(true)}
        onDecide={onDecide}
      />
    );
  }

  it("ignores Approve and Deny until its details have been on screen for a moment", async () => {
    const onDecide = vi.fn();
    render(<Reviewable onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));

    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).not.toHaveBeenCalled();

    await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith(pending, "approve");
  });

  // Disabled, the two buttons would leave the tab order: a Tab right after
  // Review would skip them and land on the next card's Review.
  it("keeps Approve and Deny in the tab order while they wait, and says so", async () => {
    const user = userEvent.setup();
    render(<Reviewable onDecide={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /review/i }));

    const deny = screen.getByRole("button", { name: "Deny" });
    const approve = screen.getByRole("button", { name: "Approve" });
    // The stops are the card's own: its scrollable details, "Show technical
    // details", then Deny — never the next card's Review.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region"));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /show technical details/i })
    );
    await user.tab();
    expect(document.activeElement).toBe(deny);
    for (const button of [deny, approve]) {
      expect(button).not.toBeDisabled();
      expect(offered(button)).toBe(false);
      expect(button).toHaveAccessibleDescription(/available in a moment/i);
    }
    expect(screen.getByText(/available in a moment/i)).toBeVisible();

    await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
    expect(offered(deny)).toBe(true);
    expect(screen.getByText(/available in a moment/i)).not.toBeVisible();
    expect(approve).not.toHaveAccessibleDescription(/available in a moment/i);
  });

  it("ignores Approve and Deny for a moment on a card drawn open, too", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pending} busy={false} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("says what Review opens, and moves focus to what it opened", () => {
    render(<Reviewable onDecide={vi.fn()} />);
    const review = screen.getByRole("button", { name: /review/i });
    expect(review).toHaveAttribute("aria-expanded", "false");
    const controls = review.getAttribute("aria-controls");
    expect(controls).toBeTruthy();

    review.focus();
    fireEvent.click(review);

    const details = screen.getByRole("group", {
      name: `Request from Smithers: Use the tool ${GENERIC_TOOL}`,
    });
    expect(details.id).toBe(controls);
    expect(document.activeElement).toBe(details);
    expect(within(details).getByText("a@b.c")).toBeInTheDocument();
  });

  it("does not take focus when it is drawn open without being asked to", () => {
    render(<ApprovalCard approval={pending} busy={false} onDecide={vi.fn()} />);
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * An open card moves when something around it changes: in the corner, a card
 * below it leaving (expired, or answered in another tab) drops it by one card
 * height, onto the pixels where that card's Review was; in the thread, a
 * message or card arriving above pushes it down. Approve and Deny act only
 * once they have stayed where they are for a moment, so a click aimed at what
 * was there never lands on them.
 */
describe("a card that moves", () => {
  const pending = approval({ to: "a@b.c" });

  /** Where every element is drawn — the test moves the page by changing it. */
  function layout() {
    const at = { top: 0 };
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, at.top, 80, 32));
    return { at, restore: () => spy.mockRestore() };
  }

  it("ignores Approve and Deny for a moment after they move", async () => {
    const page = layout();
    try {
      const onDecide = vi.fn();
      render(<ApprovalCard approval={pending} busy={false} onDecide={onDecide} />);
      const approve = screen.getByRole("button", { name: "Approve" });
      const deny = screen.getByRole("button", { name: "Deny" });
      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });

      // The click lands before the next frame has seen the move.
      page.at.top = 120;
      fireEvent.click(approve);
      fireEvent.click(deny);
      expect(onDecide).not.toHaveBeenCalled();
      expect(offered(approve)).toBe(false);
      expect(screen.getByText(/available in a moment/i)).toBeVisible();

      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
      fireEvent.click(approve);
      expect(onDecide).toHaveBeenCalledWith(pending, "approve");
    } finally {
      page.restore();
    }
  });

  it("waits the full moment from where they stopped, not from when they first moved", async () => {
    const page = layout();
    try {
      const onDecide = vi.fn();
      render(<ApprovalCard approval={pending} busy={false} onDecide={onDecide} />);
      const approve = screen.getByRole("button", { name: "Approve" });
      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });

      // A scroll: moving a little at a time, then resting.
      page.at.top += 1;
      await waitFor(() => expect(offered(approve)).toBe(false));
      const start = performance.now();
      while (performance.now() - start < ARM_MS * 0.6) {
        page.at.top += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const stopped = performance.now();
      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
      expect(performance.now() - stopped).toBeGreaterThanOrEqual(ARM_MS - 100);
    } finally {
      page.restore();
    }
  });

  // The pointer was resting where the person aimed it; Approve arrived under
  // it and they pressed straight away. Holding the press until Approve has
  // stood still for long enough does not make it a press aimed at Approve.
  it("ignores a press that started while they were moving, however long it is held", async () => {
    const page = layout();
    try {
      const onDecide = vi.fn();
      render(<ApprovalCard approval={pending} busy={false} onDecide={onDecide} />);
      const approve = screen.getByRole("button", { name: "Approve" });
      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });

      page.at.top = 120;
      fireEvent.pointerDown(approve);
      await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
      fireEvent.pointerUp(approve);
      fireEvent.click(approve, { detail: 1 });
      expect(onDecide).not.toHaveBeenCalled();

      await userEvent.click(approve);
      expect(onDecide).toHaveBeenCalledWith(pending, "approve");
    } finally {
      page.restore();
    }
  });
});

/**
 * A pointer press counts only if it both starts and ends on a button that has
 * stayed in place; the keyboard, which has no press to start, is checked when
 * it acts.
 */
describe("pressing Approve", () => {
  const pending = approval({ to: "a@b.c" });

  async function armed() {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pending} busy={false} onDecide={onDecide} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    await waitFor(() => expect(offered(approve)).toBe(true), { timeout: ARM_MS + 1000 });
    return { onDecide, approve };
  }

  it("approves on a pointer press that starts and ends on it while it is still", async () => {
    const { onDecide, approve } = await armed();
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith(pending, "approve");
  });

  it("approves on a tap, whose pointer leaves before the click arrives", async () => {
    const { onDecide, approve } = await armed();
    fireEvent.pointerDown(approve, { pointerType: "touch" });
    fireEvent.pointerUp(approve, { pointerType: "touch" });
    fireEvent.pointerLeave(approve, { pointerType: "touch" });
    fireEvent.click(approve, { detail: 1 });
    expect(onDecide).toHaveBeenCalledWith(pending, "approve");
  });

  it("approves from the keyboard, which has no press", async () => {
    const { onDecide, approve } = await armed();
    approve.focus();
    await userEvent.keyboard("{Enter}");
    expect(onDecide).toHaveBeenCalledWith(pending, "approve");
  });

  // A press that started somewhere else — on a button that has since left the
  // page, say — and was released on Approve.
  it("ignores a pointer click whose press did not start on it", async () => {
    const { onDecide, approve } = await armed();
    fireEvent.pointerUp(approve);
    fireEvent.click(approve, { detail: 1 });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it.each([
    ["leaves it", fireEvent.pointerLeave],
    ["is cancelled", fireEvent.pointerCancel],
  ])("ignores a press whose pointer %s before it is released", async (_, interrupt) => {
    const { onDecide, approve } = await armed();
    fireEvent.pointerDown(approve);
    interrupt(approve);
    fireEvent.pointerUp(approve);
    fireEvent.click(approve, { detail: 1 });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

/**
 * #1310. The card says what will happen in words, previews the effect, and
 * keeps the raw call behind "Show technical details" — without moving any
 * value out of view (#1242): what the card shows is what will run.
 */
describe("says what will happen, in words", () => {
  it("names the file it creates and draws its rows as a table", () => {
    const summary = summarizeArgs({
      filename: "test",
      format: "csv",
      columns: ["Name", "Wert"],
      rows: [["A", 1]],
    });
    const { container } = renderCard(summary, "pinchy_generate_file");
    const group = screen.getByRole("group");
    expect(drawnText(group)).toContain("Create a CSV file named test with 2 columns and 1 row");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map(drawnText)).toEqual(["Name", "Wert"]);
    const [row] = within(table).getAllByRole("row").slice(1);
    expect(within(row).getAllByRole("cell").map(drawnText)).toEqual(["A", "1"]);
    // No list of lists: the rows used to read "• • A / • 1".
    expect(container.querySelector("ul ul, li > ul")).toBeNull();
    // The raw parameter names stay behind the disclosure.
    expect(screen.queryByText("filename")).toBeNull();
    expect(screen.queryByText("rows")).toBeNull();
  });

  it("names the recipient and subject of an email and says it goes out right away", () => {
    renderCard(
      summarizeArgs({ to: "ada@example.com", subject: "Q3 numbers", body: "Hi Ada" }),
      "email_send"
    );
    const group = screen.getByRole("group", { name: "Request from Smithers: Send an email" });
    expect(drawnText(group)).toContain(
      "Send an email to ada@example.com with the subject Q3 numbers"
    );
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
      "To",
      "Subject",
      "Message",
    ]);
    expect(screen.getByText(/goes out right away/)).toBeInTheDocument();
  });

  it("names an Odoo record type in words beside its technical name", () => {
    renderCard(
      summarizeArgs({ model: "res.partner", ids: [7], values: { name: "Acme", is_company: true } }),
      "odoo_write"
    );
    expect(drawnText(screen.getByRole("group"))).toContain(
      "Update 1 record in Contacts (res.partner) in Odoo"
    );
    expect(screen.getByText("Is company")).toBeInTheDocument();
  });

  it("says when an action can't be undone", () => {
    renderCard(summarizeArgs({ path: "/data/a.md" }), "pinchy_delete");
    expect(screen.getByText("A deleted file can't be restored.")).toBeInTheDocument();
  });

  // The sentence is built from the values the tool will run with. Whatever the
  // agent said in the chat, the card names the address the call carries.
  it("names the recipient the call carries, in the sentence and below it", () => {
    renderCard(summarizeArgs({ to: "attacker@evil.com", subject: "x", body: "y" }), "email_send");
    expect(screen.getAllByText("attacker@evil.com")).toHaveLength(2);
  });

  it("repeats a recipient's notes in the sentence too", () => {
    renderCard(summarizeArgs({ to: "Boss <boss@f\u0456rma.at>", subject: "x" }), "email_send");
    expect(document.querySelectorAll('[data-annotation="host"]')).toHaveLength(2);
  });

  it("reads a value in the sentence in quotes, apart from the words around it", () => {
    renderCard(summarizeArgs({ path: "/data/a.md" }), "pinchy_delete");
    expect(spokenText(screen.getByRole("group"))).toContain('Delete the file "/data/a.md"');
  });
});

describe("shows every value without opening anything", () => {
  /** Every text and number the summary holds, as the card reads it aloud. */
  function leaves(value: unknown): string[] {
    if (typeof value === "string") return [`"${value.replace(/["\\]/g, "\\$&")}"`];
    if (typeof value === "number") return [String(value)];
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
    return [];
  }

  // `bcc` and `notify` are no parameter of these tools: the tools refuse
  // them, but the card is drawn before that, and must not hide them because a
  // preview did not expect them.
  it.each([
    ["pinchy_generate_file", { filename: "q3", format: "csv", columns: ["a"], rows: [["1"]] }],
    ["email_send", { to: "ada@example.com", subject: "Hi", body: "Text", replyTo: "m1" }],
    ["email_draft", { to: "ada@example.com", subject: "Hi", body: "Text" }],
    ["pinchy_write", { path: "/data/a.md", content: "Report", overwrite: true }],
    ["pinchy_delete", { path: "/data/a.md" }],
    ["odoo_create", { model: "res.partner", values: { name: "Acme" }, allow_duplicate: true }],
    ["odoo_write", { model: "res.partner", ids: [7], values: { name: "Acme" } }],
    ["odoo_delete", { model: "res.partner", targets: ["r1"] }],
    ["odoo_confirm_order", { order_id: 9 }],
  ])("draws every value of %s, an unexpected field included", (tool, args) => {
    const summary = summarizeArgs({ ...args, bcc: "spy@evil.com", notify: 42 });
    renderCard(summary, tool);
    const spoken = spokenText(screen.getByRole("group"));
    // A known file format is said in words — "a CSV file" — the one value the
    // card names rather than draws, since it maps one to one onto them.
    const { format, ...drawn } = summary;
    if (format !== undefined) expect(spoken).toContain("Create a CSV file");
    for (const leaf of leaves(drawn)) expect(spoken, leaf).toContain(leaf);
    expect(screen.getByText("BCC")).toBeInTheDocument();
  });

  it("says which values the preview does not cover", () => {
    renderCard(summarizeArgs({ path: "/a.md", content: "x", mode: "append" }), "pinchy_write");
    expect(screen.getByText("Also included")).toBeInTheDocument();
    expect(screen.getByText("Mode")).toBeInTheDocument();
  });

  it("draws a list of rows as a table under any tool", () => {
    const { container } = renderCard({
      matrix: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(container.querySelector("li > ul")).toBeNull();
  });

  it("keeps an empty row in a list, rather than drawing it as nothing", () => {
    const { container } = renderCard({ matrix: [["a"], []] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector("dd > ul")!.children).toHaveLength(2);
    expect(screen.getByText("[]")).toBeInTheDocument();
  });
});

describe("technical details", () => {
  it("are closed until asked for, then show the call under its raw names", async () => {
    renderCard(
      summarizeArgs({ filename: "test", format: "csv", columns: ["a"], rows: [["1"]] }),
      "pinchy_generate_file"
    );
    const toggle = screen.getByRole("button", { name: "Show technical details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeVisible();
    expect(screen.queryByText("pinchy_generate_file")).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide technical details");
    expect(screen.getByText("pinchy_generate_file")).toBeInTheDocument();
    expect(screen.getByText("filename")).toBeInTheDocument();
    expect(screen.getByText("rows")).toBeInTheDocument();
  });
});

describe("a closed card", () => {
  it("says what the agent wants to do, without any value", () => {
    render(
      <ApprovalCard
        approval={approval(summarizeArgs({ to: "ada@example.com", subject: "Hi" }), "email_send")}
        busy={false}
        open={false}
        onDecide={vi.fn()}
      />
    );
    expect(screen.getByText("Send an email")).toBeInTheDocument();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review the request from Smithers: Send an email" })
    ).toBeInTheDocument();
  });
});

describe("a list inside a list", () => {
  // Odoo's command tuples: `[[0, 0, {…}]]` drew "• • 0".
  it("is set off as a block, not given a second bullet", () => {
    const { container } = renderCard({ lines: [[0, 0, { name: "Server" }]] });
    const outer = container.querySelector("dd > ul")!;
    const [item] = [...outer.children];
    expect(item.className).toContain("list-none");
    expect(item.querySelector(":scope > ul")).not.toBeNull();
    expect(screen.getByText("Server")).toBeInTheDocument();
  });
});

describe("review: a ragged list of rows", () => {
  it("is drawn as lists, one cell per value it holds, not padded into a table", () => {
    const wide = Array.from({ length: 50 }, () => "1");
    const { container } = renderCard({ matrix: [["a"], ["b"], wide] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelectorAll("li").length).toBe(3 + 1 + 1 + 50);
  });

  // Theoretical — every Pinchy tool refuses an undeclared field — but the
  // card is drawn first: the extra field keeps its raw name, in the raw style.
  it("names an extra field apart from a section label that reads the same", () => {
    renderCard(summarizeArgs({ to: "a@b.at", subject: "Q3", Subject: "Payroll" }), "email_send");
    const terms = screen.getAllByRole("term");
    expect(terms.map((term) => term.textContent)).toEqual(["To", "Subject", "Subject"]);
    expect(terms[1].className).not.toContain("font-mono");
    expect(terms[2].className).toContain("font-mono");
    expect(screen.getByText("Also included")).toBeInTheDocument();
  });
});

describe("review: wide and long previews", () => {
  // In the 320px corner a sideways-scrolling table hid columns past the
  // edge, and a fixed-width one broke numbers mid-value ("124" / "0.5").
  // Past three columns each row is a block of "column: value" lines.
  const wide = {
    filename: "invoices",
    format: "csv",
    columns: ["Customer", "Invoice", "Date", "Net", "VAT", "Gross"],
    rows: [
      ["Acme GmbH", "INV-1", "2026-11-05", 1240.5, 248.1, 1488.6],
      ["Nordwind AG", "INV-2", "2026-11-06", -860, -172, -1032],
    ],
  };

  it("draws a row of more than three columns as a block of column: value lines", () => {
    renderCard(summarizeArgs(wide), "pinchy_generate_file");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("6 columns · 2 rows")).toBeInTheDocument();
    expect(screen.getByText("Row 1")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Contents" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const terms = within(rows[0]).getAllByRole("term").map(drawnText);
    expect(terms).toEqual(wide.columns);
    const values = within(rows[0]).getAllByRole("definition").map(drawnText);
    expect(values).toEqual(["Acme GmbH", "INV-1", "2026-11-05", "1240.5", "248.1", "1488.6"]);
  });

  it("keeps a table of up to three columns, sized to its content", () => {
    renderCard(
      summarizeArgs({
        filename: "q",
        format: "csv",
        columns: ["a", "b", "c"],
        rows: [["1", 2, 3]],
      }),
      "pinchy_generate_file"
    );
    const table = screen.getByRole("table");
    expect(table.className).not.toContain("table-fixed");
    expect(table.innerHTML).not.toContain("overflow-wrap:anywhere");
    expect(screen.getByText("3 columns · 1 row")).toBeInTheDocument();
  });

  it("names costly columns once, and each block's cells by number", () => {
    const label = "📄".repeat(31);
    const rows = Array.from({ length: 120 }, (_, i) => [`v${i}`, "", "", ""]);
    const { container } = renderCard(
      summarizeArgs({ filename: "q", format: "csv", columns: [label, "b", "c", "d"], rows }),
      "pinchy_generate_file"
    );
    expect(container.textContent!.split(label).length - 1).toBe(2); // drawn + spoken, once
    expect(screen.getAllByText("Column 1").length).toBe(120 + 1);
  });

  it("shows every row, however many there are", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`r${i}`, i, i, i]);
    renderCard(
      summarizeArgs({ ...wide, columns: ["a", "b", "c", "d"], rows }),
      "pinchy_generate_file"
    );
    expect(
      within(screen.getByRole("list", { name: "Contents" })).getAllByRole("listitem")
    ).toHaveLength(40);
    expect(screen.getByText("r39")).toBeInTheDocument();
  });

  it("lets the keyboard reach and scroll the preview", () => {
    renderCard(summarizeArgs({ to: "a@b.at", subject: "x", body: "y" }), "email_send");
    const region = screen.getByRole("region", { name: "What will be sent to the tool" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("says a warning is a warning to a screen reader", () => {
    renderCard(summarizeArgs({ path: "/a.md" }), "pinchy_delete");
    expect(spokenText(screen.getByRole("group"))).toContain(
      "Warning: A deleted file can't be restored."
    );
  });
});
