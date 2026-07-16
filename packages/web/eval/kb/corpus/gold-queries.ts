/**
 * Gold retrieval expectations for the KB evaluation harness's Layer 1
 * (retrieval quality — recall@k, nDCG). Every query targets exact chunk ids
 * from `./manifest.ts`'s `KB_EVAL_CORPUS` — see Task 0.3 in the KB eval
 * harness plan.
 *
 * Every `GoldQuery` here has a NON-EMPTY `relevantChunkIds`: Layer 1's
 * `recallAtK` treats an empty relevant set as vacuously 1 (trivially
 * "passing" with zero retrieved chunks), so an abstention-style query with no
 * relevant chunks does not belong in this file — that case lives only in
 * `gold-qa.ts` (Layer 3), where `expectAbstention: true` is the actual
 * signal being tested.
 *
 * `relevantChunkIds` order is the ideal rank (most relevant first), since
 * nDCG scoring is order-sensitive.
 *
 * Axis coverage (six `KbEvalAxis` members, four queries each):
 *
 * - happy: `it-equipment-policy.md` — plain, unambiguous, no adjacent trap.
 * - path-citation: `handbook-2011/policy.md` vs `handbook-2012/policy.md` —
 *   same basename, two folders, different per-diem figures.
 * - dedup: `product-insert.md` vs `quality-file.md` — the cartridge-life
 *   fact is reworded across both; a good retriever surfaces both as
 *   relevant (not proof of independent corroboration).
 * - multi-hop: `onboarding-part1.md` (timing) + `onboarding-part2.md`
 *   (module code) — neither document alone answers the combined question.
 * - distractor: `retention-correct.md` (support tickets) vs
 *   `retention-distractor.md` (marketing email) — adjacent-but-different
 *   retention periods.
 * - cross-lingual: `vacation-policy-en.md` / `urlaub-policy-de.md` — a
 *   faithful translation pair. Two queries per language are genuine
 *   language-crossing tests (DE query -> EN-only chunk, and vice versa);
 *   the relevant set intentionally excludes the same-language chunk so a
 *   retriever cannot pass by ignoring the cross-lingual bridge entirely.
 *   The other two queries are same-language baselines within the axis.
 *
 * Language coverage: both "de" and "en" appear across the full set (17 en /
 * 7 de), not necessarily balanced within every axis.
 */

import type { GoldQuery } from "../../../src/lib/eval/kb/types";

export const GOLD_QUERIES: GoldQuery[] = [
  // --- happy: it-equipment-policy.md, no adjacent trap ---
  {
    id: "gq-happy-1",
    lang: "en",
    query: "How often does Northwind replace employee laptops?",
    relevantChunkIds: ["it-equipment-policy#c1"],
    axis: "happy",
  },
  {
    id: "gq-happy-2",
    lang: "en",
    query: "What laptop configuration do new full-time employees receive on hire?",
    relevantChunkIds: ["it-equipment-policy#c1"],
    axis: "happy",
  },
  {
    id: "gq-happy-3",
    lang: "en",
    query: "How do I request a second monitor at Northwind?",
    relevantChunkIds: ["it-equipment-policy#c2"],
    axis: "happy",
  },
  {
    id: "gq-happy-4",
    lang: "de",
    query: "Wie kann ich zusätzliche IT-Ausstattung wie einen zweiten Monitor beantragen?",
    relevantChunkIds: ["it-equipment-policy#c2"],
    axis: "happy",
  },

  // --- path-citation: handbook-2011/policy.md vs handbook-2012/policy.md ---
  {
    id: "gq-pathcite-1",
    lang: "en",
    query: "What is the daily meal per diem for business travel under the 2012 handbook revision?",
    relevantChunkIds: ["handbook-2012/policy#c2"],
    axis: "path-citation",
  },
  {
    id: "gq-pathcite-2",
    lang: "en",
    query: "What was the daily meal per diem for business travel before the 2012 revision?",
    relevantChunkIds: ["handbook-2011/policy#c2"],
    axis: "path-citation",
  },
  {
    id: "gq-pathcite-3",
    lang: "en",
    query:
      "Within how many days must an employee log trip dates after returning from travel, under the 2012 revision?",
    relevantChunkIds: ["handbook-2012/policy#c2"],
    axis: "path-citation",
  },
  {
    id: "gq-pathcite-4",
    lang: "de",
    query: "Für wen gilt die Reisekostenregelung in der Handbuch-Fassung von 2011?",
    relevantChunkIds: ["handbook-2011/policy#c1"],
    axis: "path-citation",
  },

  // --- dedup: product-insert.md vs quality-file.md, reworded duplicate passage ---
  {
    id: "gq-dedup-1",
    lang: "en",
    query: "How often should the Aqua-Filter 200 cartridge be replaced?",
    relevantChunkIds: ["product-insert#c2", "quality-file#c2"],
    axis: "dedup",
  },
  {
    id: "gq-dedup-2",
    lang: "en",
    query: "How do I install the Aqua-Filter 200 under the sink?",
    relevantChunkIds: ["product-insert#c1"],
    axis: "dedup",
  },
  {
    id: "gq-dedup-3",
    lang: "en",
    query: "What does the Aqua-Filter 200 quality file track?",
    relevantChunkIds: ["quality-file#c1"],
    axis: "dedup",
  },
  {
    id: "gq-dedup-4",
    lang: "de",
    query: "Wie oft muss die Filterkartusche des Aqua-Filter 200 ausgetauscht werden?",
    relevantChunkIds: ["product-insert#c2", "quality-file#c2"],
    axis: "dedup",
  },

  // --- multi-hop: onboarding-part1.md (timing) + onboarding-part2.md (module code) ---
  {
    id: "gq-multihop-1",
    lang: "en",
    query:
      "When must new hires complete the mandatory security training, and what is its module code?",
    relevantChunkIds: ["onboarding-part1#c1", "onboarding-part2#c1"],
    axis: "multi-hop",
  },
  {
    id: "gq-multihop-2",
    lang: "en",
    query: "Where do new hires pick up their laptop and badge on day one?",
    relevantChunkIds: ["onboarding-part1#c2"],
    axis: "multi-hop",
  },
  {
    id: "gq-multihop-3",
    lang: "en",
    query: "How can employees check the completion status of an assigned training module?",
    relevantChunkIds: ["onboarding-part2#c2"],
    axis: "multi-hop",
  },
  {
    id: "gq-multihop-4",
    lang: "de",
    query:
      "Wann müssen neue Mitarbeitende das Sicherheitstraining abschließen und wie lautet der Modulcode?",
    relevantChunkIds: ["onboarding-part1#c1", "onboarding-part2#c1"],
    axis: "multi-hop",
  },

  // --- distractor: retention-correct.md vs retention-distractor.md ---
  {
    id: "gq-distractor-1",
    lang: "en",
    query: "How long are customer support tickets retained?",
    relevantChunkIds: ["retention-correct#c1"],
    axis: "distractor",
  },
  {
    id: "gq-distractor-2",
    lang: "en",
    query: "How long are marketing email campaign records retained?",
    relevantChunkIds: ["retention-distractor#c1"],
    axis: "distractor",
  },
  {
    id: "gq-distractor-3",
    lang: "en",
    query: "What happens to support tickets after the retention period expires?",
    relevantChunkIds: ["retention-correct#c2"],
    axis: "distractor",
  },
  {
    id: "gq-distractor-4",
    lang: "de",
    query: "Wie lange werden Support-Tickets aufbewahrt?",
    relevantChunkIds: ["retention-correct#c1"],
    axis: "distractor",
  },

  // --- cross-lingual: vacation-policy-en.md / urlaub-policy-de.md translation pair ---
  {
    id: "gq-crosslingual-1",
    lang: "de",
    query: "Wie viele Urlaubstage sammeln Vollzeitbeschäftigte pro Monat an?",
    // Genuine cross-lingual test: DE query, relevant chunk is EN-only.
    relevantChunkIds: ["vacation-policy-en#c1"],
    axis: "cross-lingual",
  },
  {
    id: "gq-crosslingual-2",
    lang: "en",
    query: "How many vacation days can be carried over into the next calendar year?",
    // Genuine cross-lingual test: EN query, relevant chunk is DE-only.
    relevantChunkIds: ["urlaub-policy-de#c2"],
    axis: "cross-lingual",
  },
  {
    id: "gq-crosslingual-3",
    lang: "de",
    query: "Wie viele Urlaubstage können ins nächste Kalenderjahr übertragen werden?",
    // Same-language baseline within the axis.
    relevantChunkIds: ["urlaub-policy-de#c2"],
    axis: "cross-lingual",
  },
  {
    id: "gq-crosslingual-4",
    lang: "en",
    query: "How many vacation days do full-time employees accrue per month?",
    // Same-language baseline within the axis.
    relevantChunkIds: ["vacation-policy-en#c1"],
    axis: "cross-lingual",
  },
];
