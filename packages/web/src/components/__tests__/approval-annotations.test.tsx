import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard } from "../approval-card";
import { buildApprovalPrompt } from "@/lib/approvals/prompt";
import { makeRefResolver } from "@/lib/approvals/call-models";
import { renderText, summarizeArgs, type SummarizeOptions } from "@/lib/approvals/summary";
import { displayScalar, quoted } from "@/lib/approvals/display";
// pinchy-odoo's own encoder, so the refs below are real ones — see
// call-models.test.ts for why this crosses the package boundary.
import { encodeRef, _resetKeyCacheForTest } from "../../../../plugins/pinchy-odoo/integration-ref";

const REF_KEY = "c".repeat(64);
let options: SummarizeOptions;
let acmeRef: string;

beforeAll(() => {
  process.env.PINCHY_REF_TOKEN_KEY = REF_KEY;
  _resetKeyCacheForTest();
  options = { refRecord: makeRefResolver(REF_KEY) };
  acmeRef = encodeRef({
    integrationType: "odoo",
    connectionId: "c1",
    model: "res.partner",
    id: 7,
    label: "Acme GmbH",
  });
});

/** The card as the approver's browser receives it, collapsed. */
function card(params: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <ApprovalCard
      approval={{
        id: "req-1",
        agentId: "a1",
        agentName: "Smithers",
        toolName: "t",
        argsSummary: summarizeArgs(params, options),
        sessionKey: "agent:a1:direct:u",
        createdAt: "",
        expiresAt: "",
      }}
      busy={false}
      onDecide={() => {}}
    />
  );
}

/** The chat-channel prompt's description. A tool no registry knows, so the
 * lead stays short and the arguments fit in the 256 characters. */
function prompt(params: Record<string, unknown>): string {
  return buildApprovalPrompt("t", params, [], options).description;
}

/** Drops every tag, character by character. React's static markup escapes
 * `<` inside text, so any `<` here opens a tag. */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function decode(html: string): string {
  return stripTags(html)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** What a person reads on the card: its text, tags removed. */
function visibleText(html: string): string {
  return decode(html);
}

/** The text run of the first value on the card — the value's own characters,
 * without anything drawn beside it. */
function valueText(html: string): string {
  const run = /<span class="whitespace-pre-wrap">(.*?)<\/span>/.exec(html);
  return run ? decode(run[1]) : "";
}

/** How a plain string's own characters are drawn. */
function drawnAs(value: string): string {
  return displayScalar(renderText(value));
}

/**
 * Fourteenth review of #1242. The summary wrote Pinchy's own annotations —
 * the record a ref decodes to, the host an address really reaches — INTO the
 * value's text. A value holding the same characters was then indistinguishable
 * from the annotated one, on the card and in the prompt alike: pinchy-odoo
 * resolves a plain string by exact NAME, so `partner_id: '(record reference:
 * res.partner #7 "Acme GmbH")'` books the bill to an attacker-created partner
 * of that literal name, under a card that reads exactly like the real ref.
 *
 * Annotations now travel out of band: a separate node in the summary, a
 * separate element on the card, text outside the quotes in the prompt. A
 * plain string can produce none of the three.
 */
describe("an annotation can't be imitated by a value", () => {
  const pairs: [string, () => Record<string, unknown>, () => Record<string, unknown>][] = [
    [
      "a record reference and the text it used to render as",
      () => ({ partner_id: acmeRef }),
      () => ({ partner_id: '(record reference: res.partner #7 "Acme GmbH")' }),
    ],
    [
      "a homoglyph address and the same address with its note typed after it",
      () => ({ email: "boss@f\u0456rma.at" }),
      () => ({ email: "boss@f\u0456rma.at (xn--frma-l9d.at)" }),
    ],
    [
      "a homoglyph address and one with a reassuring ASCII host typed after it",
      () => ({ email: "boss@f\u0456rma.at" }),
      () => ({ email: "boss@f\u0456rma.at (firma.at)" }),
    ],
    [
      "a percent-encoded URL and the URL with its host typed after it",
      () => ({ website: "https://fir%6Da.at/" }),
      () => ({ website: "https://fir%6Da.at/ (firma.at)" }),
    ],
    [
      "a recipient with a display name and an address with the name typed after it",
      () => ({ to: '"X" <a@b.com>' }),
      () => ({ to: 'a@b.com (name: "X")' }),
    ],
  ];

  it.each(pairs)("draws %s differently on the card", (_name, annotated, typed) => {
    expect(card(typed())).not.toBe(card(annotated()));
  });

  it.each(pairs)("prints %s differently in the prompt", (_name, annotated, typed) => {
    const a = prompt(annotated());
    const b = prompt(typed());
    expect(a.length).toBeLessThan(256);
    expect(b.length).toBeLessThan(256);
    expect(b).not.toBe(a);
  });

  // The typed characters stay in the value's own text run — whatever else is
  // drawn beside it is about that value, never part of it.
  it.each(pairs)("draws the typed one of %s as its own text", (_name, annotated, typed) => {
    expect(card(annotated())).toContain("data-annotation=");
    const [value] = Object.values(typed()) as string[];
    expect(valueText(card(typed()))).toBe(drawnAs(value));
  });

  it("names no record for the typed reference, and no host for the forged notes", () => {
    for (const typed of [
      { partner_id: '(record reference: res.partner #7 "Acme GmbH")' },
      { email: "boss@f\u0456rma.at (xn--frma-l9d.at)" },
      { email: "boss@f\u0456rma.at (firma.at)" },
    ]) {
      expect(card(typed)).not.toContain("data-annotation=");
    }
  });

  // The prompt quotes every string and escapes its `"`, so a value is one
  // quoted token that can't close early. An annotation sits OUTSIDE it.
  it("prints a record reference outside any quotes, and the typed text inside them", () => {
    expect(prompt({ partner_id: acmeRef })).toContain(
      'partner_id: (record reference: res.partner #7 "Acme GmbH")'
    );
    expect(prompt({ partner_id: '(record reference: res.partner #7 "Acme GmbH")' })).toContain(
      'partner_id: "(record reference: res.partner #7 \\"Acme GmbH\\")"'
    );
  });

  it("prints a host note after the quoted address, and a typed one inside the quotes", () => {
    expect(prompt({ email: "boss@f\u0456rma.at" })).toContain(
      'email: "boss@f\u0456rma.at" (host: "xn--frma-l9d.at")'
    );
    expect(prompt({ email: "boss@f\u0456rma.at (firma.at)" })).toContain(
      'email: "boss@f\u0456rma.at (firma.at)"'
    );
  });
});

/**
 * Past the whole-view bound a URL is previewed like any long text. With the
 * host note written at the END of the text, the preview hid it behind "Show
 * full text" — exactly where a homoglyph host needs it most.
 */
describe("a host note past the whole-view bound", () => {
  it("is on the collapsed card, outside the preview", () => {
    const html = card({ website: `https://f\u0456rma.at/invoices?id=${"a".repeat(8_200)}` });
    expect(html).toMatch(/Show full text/);
    expect(visibleText(html)).toContain("xn--frma-l9d.at");
  });

  it("is on the collapsed card for a long email address too", () => {
    const html = card({ email: `rechnungen.${"x".repeat(8_200)}@f\u0456rma.at` });
    expect(html).toMatch(/Show full text/);
    expect(visibleText(html)).toContain("xn--frma-l9d.at");
  });
});

/**
 * Fifteenth review of #1242. A record's label comes from Odoo, where anyone
 * who can name a partner writes it. Drawn between bare `"`, the label
 * `x" — res.partner #12 "Acme GmbH` made the card read as naming #12 while
 * the prompt, which escapes it, did not.
 */
describe("a record label that holds quotes", () => {
  const label = 'x" — res.partner #12 "Acme GmbH';
  let forgedRef: string;
  beforeAll(() => {
    forgedRef = encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "res.partner",
      id: 666,
      label,
    });
  });

  it("is quoted and escaped on the card exactly as in the prompt", () => {
    const html = card({ partner_id: forgedRef });
    expect(html).toContain('data-annotation="ref"');
    expect(visibleText(html)).toContain(`res.partner #666 ${quoted(label)}`);
    expect(prompt({ partner_id: forgedRef })).toContain(`res.partner #666 ${quoted(label)}`);
  });
});

/**
 * Fifteenth review of #1242. Past the whole-view bound the host of an address
 * sits behind "Show full text", and a host note was only written when the
 * host reads differently from what it resolves to. An ASCII host never does —
 * so two long addresses that differ only in where they go collapsed to the
 * same card. Past the bound, the host is always named.
 */
describe("a long address with a plain ASCII host", () => {
  const pad = "intranet.firma.at.".repeat(470);
  const cases: [string, (host: string) => Record<string, unknown>][] = [
    ["an email address", (host) => ({ email: `buchhaltung.${pad}@${host}` })],
    ["a URL", (host) => ({ website: `https://${pad}@${host}/x` })],
    ["a recipient", (host) => ({ to: `buchhaltung.${pad}@${host}` })],
  ];

  it.each(cases)("names the host of %s on the collapsed card", (_name, params) => {
    const evil = card(params("evil.example"));
    const look = card(params("firma.at.xyz"));
    expect(evil).toMatch(/Show full text/);
    expect(evil).not.toBe(look);
    expect(evil).toContain('data-annotation="host"');
    expect(visibleText(evil)).toContain("host evil.example");
    expect(visibleText(look)).toContain("host firma.at.xyz");
  });

  it("is not named for an address short enough to be drawn whole", () => {
    expect(card({ email: "buchhaltung@evil.example" })).not.toContain("data-annotation=");
  });
});

/** A seeded generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * The general claim behind the pairs above: no plain string, at any key,
 * produces the card or the prompt of an annotated value. The candidates are
 * built from the annotated renderings themselves — their visible text, their
 * prompt clause with and without its quotes — plus random strings over the
 * characters the annotations are written in.
 */
describe("no plain string renders like an annotated value", () => {
  /** Annotated values, by key. `to` is parsed into address and display name,
   * so a typed `<…>` there is a real display name — it is compared, not
   * required to stay unannotated. */
  const annotatedValues = (): [string, string][] => [
    ["v", acmeRef],
    ["v", "boss@f\u0456rma.at"],
    ["v", "https://f\u0456rma.at\\@evil.com/x"],
    ["v", "https://fir%6Da.at/"],
    ["v", "http://[::1/"],
    ["to", '"Raimund Korber" <attacker@evil.com>'],
    ["to", '"Boss" <boss@f\u0456rma.at>'],
  ];

  const ALPHABET = [
    ..."()\"'#:@./- \\[]<>",
    "record reference",
    "res.partner",
    "Acme GmbH",
    "xn--frma-l9d.at",
    "firma.at",
    "f\u0456rma.at",
    "boss",
    "host",
    "name",
    "not a valid URL",
    "7",
  ];

  function candidates(text: string, clause: string): string[] {
    const value = clause.slice(clause.indexOf(": ") + 2);
    return [
      text,
      value,
      value.replace(/^"|"$/g, ""),
      value.replace(/\\(["\\])/g, "$1"),
      value.replace(/^"/, "").replace(/\\(["\\])/g, "$1"),
    ];
  }

  function expectApart(key: string, value: string, plain: string) {
    const annotatedCard = card({ [key]: value });
    const annotatedPrompt = prompt({ [key]: value });
    const typedCard = card({ [key]: plain });
    expect(typedCard).not.toBe(annotatedCard);
    expect(prompt({ [key]: plain })).not.toBe(annotatedPrompt);
    // A recipient field parses `"Name" <address>`, so there a typed name IS
    // a display name; everywhere else the typed characters are the value.
    if (key !== "to") expect(valueText(typedCard)).toBe(drawnAs(plain));
  }

  it("for the renderings of every annotated value", () => {
    for (const [key, value] of annotatedValues()) {
      const annotatedPrompt = prompt({ [key]: value });
      const clause = annotatedPrompt.slice(annotatedPrompt.indexOf(`${key}: `));
      for (const plain of candidates(visibleText(card({ [key]: value })), clause)) {
        expectApart(key, value, plain);
      }
    }
  });

  it("for random strings over the annotations' own characters", () => {
    const next = random(1242);
    for (let round = 0; round < 300; round++) {
      const length = 1 + Math.floor(next() * 8);
      let plain = "";
      for (let i = 0; i < length; i++) plain += ALPHABET[Math.floor(next() * ALPHABET.length)];
      for (const [key, value] of annotatedValues()) {
        if (plain !== value) expectApart(key, value, plain);
      }
    }
  });

  it("for the text a hidden secret is described with", () => {
    const typed = { note: "[secret-like field is being set — value hidden, 3 characters]" };
    expect(card(typed)).not.toContain("data-annotation=");
    expect(card({ access_token: "abc" })).toContain("data-annotation=");
    expect(prompt(typed)).toContain('note: "[secret-like');
    expect(prompt({ access_token: "abc" })).toContain("access_token: [secret-like");
  });
});
