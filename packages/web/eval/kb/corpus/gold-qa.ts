/**
 * Gold Q/A set for the KB evaluation harness's Layer 3 (groundedness /
 * answer-relevance). Each item is a `GoldQA` — a `GoldQuery` plus a
 * `referenceAnswer` (invented, factually consistent with the corpus, judged
 * rather than string-matched) and, for the abstention case, an
 * `expectAbstention` flag.
 *
 * This is a subset of `gold-queries.ts`'s questions (reusing the same
 * underlying questions where natural) plus the corpus's one deliberately
 * unanswerable topic. `GoldQA` is its own array — it is not derived from
 * `GOLD_QUERIES` at runtime, so the two can diverge deliberately (e.g. a
 * query worth testing for retrieval need not need a hand-written reference
 * answer, and vice versa).
 *
 * Abstention: `absent-topic-pointer.md` names "parental leave" as a section
 * title but contains no substantive policy text about it (see
 * `manifest.ts`). The only honest answer is abstention, so both abstention
 * items here have `relevantChunkIds: []` — the ONE place an empty relevant
 * set is correct, since Layer 3 grades whether the system recognizes the
 * absence rather than scoring retrieval recall. `referenceAnswer` is still
 * populated (the type requires a string) with the ideal abstention text, so
 * a groundedness judge has something to compare the system's abstention
 * against.
 *
 * These two items are tagged `axis: "distractor"`: `KbEvalAxis` has no
 * dedicated "abstention" member (the manifest's design commentary uses that
 * label informally, but the type only has six formal axes). "distractor"
 * fits best — the failure mode under test is the same temptation to
 * fabricate an answer from adjacent-but-insufficient text that the
 * retention-correct/retention-distractor pair exercises for retrieval.
 */

import type { GoldQA } from "../../../src/lib/eval/kb/types";

export const GOLD_QA: GoldQA[] = [
  {
    id: "gqa-happy-1",
    lang: "en",
    query: "How often does Northwind replace employee laptops?",
    relevantChunkIds: ["it-equipment-policy#c1"],
    axis: "happy",
    referenceAnswer:
      "Northwind replaces employee laptops on a 3-year refresh cycle managed by the IT helpdesk.",
  },
  {
    // Source query: gq-happy-3 (not gq-happy-2) — the one place the trailing
    // number does not line up between GOLD_QUERIES and GOLD_QA.
    id: "gqa-happy-2",
    lang: "en",
    query: "How do I request a second monitor at Northwind?",
    relevantChunkIds: ["it-equipment-policy#c2"],
    axis: "happy",
    referenceAnswer:
      "Employees who need non-standard equipment such as a second monitor must submit a request through the IT service desk portal with manager approval.",
  },
  {
    id: "gqa-pathcite-1",
    lang: "en",
    query: "What is the daily meal per diem for business travel under the 2012 handbook revision?",
    relevantChunkIds: ["handbook-2012/policy#c2"],
    axis: "path-citation",
    referenceAnswer:
      "Under the 2012 handbook revision, the daily meal per diem for approved business travel is $60.",
  },
  {
    id: "gqa-pathcite-2",
    lang: "en",
    query: "What was the daily meal per diem for business travel before the 2012 revision?",
    relevantChunkIds: ["handbook-2011/policy#c2"],
    axis: "path-citation",
    referenceAnswer:
      "Before the 2012 revision, the daily meal per diem for approved business travel was $45.",
  },
  {
    id: "gqa-dedup-1",
    lang: "en",
    query: "How often should the Aqua-Filter 200 cartridge be replaced?",
    relevantChunkIds: ["product-insert#c2", "quality-file#c2"],
    axis: "dedup",
    referenceAnswer:
      "The Aqua-Filter 200 cartridge should be replaced every 6 months, or after filtering about 1,200 gallons, whichever comes first.",
  },
  {
    id: "gqa-multihop-1",
    lang: "en",
    query:
      "When must new hires complete the mandatory security training, and what is its module code?",
    relevantChunkIds: ["onboarding-part1#c1", "onboarding-part2#c1"],
    axis: "multi-hop",
    referenceAnswer:
      "New hires must complete the mandatory IT security awareness training during their first week, before receiving production system access. The training is catalogued as module SEC-100 in the Northwind Learning Portal.",
  },
  {
    id: "gqa-distractor-1",
    lang: "en",
    query: "How long are customer support tickets retained?",
    relevantChunkIds: ["retention-correct#c1"],
    axis: "distractor",
    referenceAnswer:
      "Customer support tickets, including attached chat transcripts, are retained for 24 months from the date the ticket is closed.",
  },
  {
    id: "gqa-distractor-2",
    lang: "en",
    query: "How long are marketing email campaign records retained?",
    relevantChunkIds: ["retention-distractor#c1"],
    axis: "distractor",
    referenceAnswer:
      "Marketing email campaign records, including delivery and open-rate logs, are retained for 12 months from the send date.",
  },
  {
    id: "gqa-crosslingual-1",
    lang: "de",
    query: "Wie viele Urlaubstage sammeln Vollzeitbeschäftigte pro Monat an?",
    relevantChunkIds: ["vacation-policy-en#c1"],
    axis: "cross-lingual",
    referenceAnswer:
      "Vollzeitbeschäftigte sammeln monatlich 2,5 Urlaubstage an und erreichen nach einem vollen Jahr ununterbrochener Beschäftigung den regulären Jahresanspruch von 30 Tagen.",
  },
  {
    id: "gqa-crosslingual-2",
    lang: "en",
    query: "How many vacation days can be carried over into the next calendar year?",
    relevantChunkIds: ["urlaub-policy-de#c2"],
    axis: "cross-lingual",
    referenceAnswer:
      "Unused vacation days may be carried over into the next calendar year, up to a maximum of 10 days. Any balance beyond that cap is forfeited on January 1st.",
  },

  // --- abstention: absent-topic-pointer.md names "parental leave" but has no substantive text ---
  {
    id: "gqa-abstention-1",
    lang: "en",
    query: "What is Northwind's parental leave policy?",
    relevantChunkIds: [],
    axis: "distractor",
    expectAbstention: true,
    referenceAnswer:
      'The knowledge base does not contain a parental leave policy. The only mention is a section-title listing in the HR policy index, which names "parental leave" but provides no substantive policy text — the correct response is to state that this information is not available rather than guessing.',
  },
  {
    id: "gqa-abstention-2",
    lang: "de",
    query: "Wie lautet Northwinds Richtlinie zur Elternzeit?",
    relevantChunkIds: [],
    axis: "distractor",
    expectAbstention: true,
    referenceAnswer:
      'Die Wissensdatenbank enthält keine Richtlinie zur Elternzeit. Der einzige Treffer ist ein Eintrag im HR-Richtlinien-Index, der „Elternzeit" nur als Abschnittstitel nennt, ohne inhaltlichen Text zu liefern — die korrekte Antwort ist, dass diese Information nicht verfügbar ist, statt zu spekulieren.',
  },
];
