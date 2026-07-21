/**
 * Synthetic corpus manifest for the KB evaluation harness.
 *
 * Every document here exists to exercise a specific failure mode the KB has
 * actually hit in production or design review, not as generic filler:
 *
 * - `handbook-2011/policy.md` + `handbook-2012/policy.md` — same basename in
 *   two different folders, with DIFFERENT policy numbers. A citation that
 *   renders only the bare filename ("policy.md") is genuinely ambiguous
 *   between the two (path-citation axis; the Block-A bug).
 * - `product-insert.md` + `quality-file.md` — the cartridge-replacement
 *   passage appears in both, reworded but not reworded enough to be a
 *   different fact. Retrieval can surface both as if they were independent
 *   corroborating sources (dedup axis; the Block-B/-F inflation bug).
 * - `onboarding-part1.md` + `onboarding-part2.md` — the "which module, and
 *   when" fact is split: part1 has the timing, part2 has the module code.
 *   Neither document alone answers the combined question (multi-hop /
 *   partial-answer axis).
 * - `retention-correct.md` + `retention-distractor.md` — both are genuine,
 *   truthful policies, but about adjacent-and-confusable topics (support
 *   tickets vs. marketing email) with different retention periods. An
 *   answer that grounds a support-ticket question in the email doc is a
 *   groundedness failure even though the cited text is real (distractor
 *   axis).
 * - `vacation-policy-en.md` + `urlaub-policy-de.md` — a faithful EN/DE
 *   translation pair with a distinctive answerable fact, for cross-lingual
 *   retrieval (cross-lingual axis).
 * - `absent-topic-pointer.md` — names "parental leave" in a section list
 *   but contains no substantive policy text about it, so the only honest
 *   answer to a parental-leave question is abstention (abstention axis).
 * - `it-equipment-policy.md` — a plain, unambiguous document with no
 *   adjacent trap, for straightforward "happy path" retrieval queries.
 * - `quality/afnor-certificate-2024.md` +
 *   `quality/OLD/afnor-certificate-2013.md` — a current certificate and its
 *   expired copy under an `OLD/` segment. The archived copy is seeded as
 *   `archived` (statusForPath), so default retrieval must return only the
 *   current cert (freshness axis; #858).
 * - `petrifilm-datasheet.md` + `quality-binder.md` — a clean single-topic
 *   datasheet and a multi-section compilation binder that reworded the same
 *   Petrifilm incubation fact. The binder's chunks must not crowd the
 *   datasheet out of the fused result list (crowding axis; #858).
 *
 * Chunk-id scheme: `<docdir-or-basename>/<basename>#c<N>` — e.g.
 * `handbook-2011/policy#c1`, `product-insert#c1`. Ids are globally unique
 * across the whole corpus and MUST NOT be reordered or renumbered once
 * authored: Task 0.3's gold queries and Task 0.4's embedding fixtures key
 * off these exact strings.
 *
 * `sourcePath` mirrors a real `/data` mount (what ingest would see); `file`
 * is the path to the raw `.md` relative to `corpus/docs/`. Every chunk's
 * `text` is an EXACT substring of that file's body — this is what gets
 * embedded and stored as `chunkText` downstream, so drift here would break
 * seeding silently.
 */

export interface CorpusDoc {
  /** The sourcePath as it will be seeded (mirrors a real /data mount). */
  sourcePath: string;
  /** Relative path to the raw .md under corpus/docs/. */
  file: string;
  /** Author-declared chunks: id + the exact substring that forms the chunk. */
  chunks: { id: string; page: number; text: string }[];
}

export const KB_EVAL_CORPUS: CorpusDoc[] = [
  // --- path-citation axis: same basename, two folders, different numbers ---
  {
    sourcePath: "/data/handbook-2011/policy.md",
    file: "handbook-2011/policy.md",
    chunks: [
      {
        id: "handbook-2011/policy#c1",
        page: 1,
        text: "This section of the Northwind Employee Handbook governs reimbursement for business travel expenses incurred by staff on approved company trips. It applies to all full-time employees and contractors traveling on Northwind business.",
      },
      {
        id: "handbook-2011/policy#c2",
        page: 1,
        text: "Employees on approved business travel are entitled to a daily meal per diem of $45. Receipts are not required for per diem claims, but employees must log the trip dates and destination in the expense system within 30 days of return.",
      },
    ],
  },
  {
    sourcePath: "/data/handbook-2012/policy.md",
    file: "handbook-2012/policy.md",
    chunks: [
      {
        id: "handbook-2012/policy#c1",
        page: 1,
        text: "This section of the Northwind Employee Handbook governs reimbursement for business travel expenses incurred by staff on approved company trips. As of the 2012 revision, it applies to all full-time employees, contractors, and interns traveling on Northwind business.",
      },
      {
        id: "handbook-2012/policy#c2",
        page: 1,
        text: "Effective the 2012 revision, the daily meal per diem for approved business travel was increased from $45 to $60. Receipts are not required for per diem claims, but employees must log the trip dates and destination in the expense system within 14 days of return.",
      },
    ],
  },

  // --- dedup axis: near-duplicate passage across two documents ---
  {
    sourcePath: "/data/product-insert.md",
    file: "product-insert.md",
    chunks: [
      {
        id: "product-insert#c1",
        page: 1,
        text: "The Northwind Aqua-Filter 200 removes sediment, chlorine taste, and odor from residential tap water using a three-stage carbon block cartridge. Install the unit under the sink and connect it to the cold water line using the supplied compression fittings.",
      },
      {
        id: "product-insert#c2",
        page: 1,
        text: "The filter cartridge should be replaced every 6 months or after filtering 1,200 gallons, whichever comes first, to maintain rated filtration performance. Continuing to use a cartridge past its rated life may reduce chlorine and sediment removal effectiveness.",
      },
    ],
  },
  {
    sourcePath: "/data/quality-file.md",
    file: "quality-file.md",
    chunks: [
      {
        id: "quality-file#c1",
        page: 1,
        text: "This quality file tracks manufacturing and field-performance notes for the Aqua-Filter 200 filtration line, reviewed quarterly by the Quality team.",
      },
      {
        id: "quality-file#c2",
        page: 1,
        text: "Per the product specification, the Aqua-Filter 200 cartridge should be replaced every 6 months, or after filtering approximately 1,200 gallons of water, whichever occurs first, in order to maintain the cartridge's rated filtration performance. Field returns show that units run past this interval show measurably reduced chlorine removal.",
      },
      {
        id: "quality-file#c3",
        page: 1,
        text: "Batch QA-2026-014 passed all inline pressure tests with no leaks detected across the sampled units.",
      },
    ],
  },

  // --- multi-hop axis: fact split across two documents ---
  {
    sourcePath: "/data/onboarding-part1.md",
    file: "onboarding-part1.md",
    chunks: [
      {
        id: "onboarding-part1#c1",
        page: 1,
        text: "All new hires must complete mandatory IT security awareness training during their first week of employment, before receiving production system access.",
      },
      {
        id: "onboarding-part1#c2",
        page: 1,
        text: "New hires are issued a laptop and badge on day one by the IT helpdesk, located on the 2nd floor of the Northwind headquarters building.",
      },
    ],
  },
  {
    sourcePath: "/data/onboarding-part2.md",
    file: "onboarding-part2.md",
    chunks: [
      {
        id: "onboarding-part2#c1",
        page: 1,
        text: "Mandatory training modules for new hires are delivered through the Northwind Learning Portal. The IT security awareness module is catalogued as module code SEC-100.",
      },
      {
        id: "onboarding-part2#c2",
        page: 1,
        text: 'Employees can track completion status for any assigned module from the "My Training" tab inside the Learning Portal.',
      },
    ],
  },

  // --- distractor / groundedness axis: adjacent-but-different retention policy ---
  {
    sourcePath: "/data/retention-correct.md",
    file: "retention-correct.md",
    chunks: [
      {
        id: "retention-correct#c1",
        page: 1,
        text: "Customer support tickets, including attached chat transcripts, are retained for 24 months from the date the ticket is closed.",
      },
      {
        id: "retention-correct#c2",
        page: 1,
        text: "After the 24-month retention period expires, tickets are permanently deleted from the support system during the monthly retention sweep.",
      },
    ],
  },
  {
    sourcePath: "/data/retention-distractor.md",
    file: "retention-distractor.md",
    chunks: [
      {
        id: "retention-distractor#c1",
        page: 1,
        text: "Marketing email campaign records, including delivery and open-rate logs, are retained for 12 months from the send date.",
      },
      {
        id: "retention-distractor#c2",
        page: 1,
        text: "Marketing operations reviews retention compliance for these records each quarter as part of the data governance checklist.",
      },
    ],
  },

  // --- cross-lingual axis: faithful EN/DE translation pair ---
  {
    sourcePath: "/data/vacation-policy-en.md",
    file: "vacation-policy-en.md",
    chunks: [
      {
        id: "vacation-policy-en#c1",
        page: 1,
        text: "Full-time employees accrue 2.5 vacation days per month, reaching the standard 30-day annual allowance after a full year of continuous employment.",
      },
      {
        id: "vacation-policy-en#c2",
        page: 1,
        text: "Unused vacation days may be carried over into the next calendar year, up to a maximum carryover cap of 10 days. Any balance beyond the cap is forfeited on January 1st.",
      },
    ],
  },
  {
    sourcePath: "/data/urlaub-policy-de.md",
    file: "urlaub-policy-de.md",
    chunks: [
      {
        id: "urlaub-policy-de#c1",
        page: 1,
        text: "Vollzeitbeschäftigte sammeln pro Monat 2,5 Urlaubstage an und erreichen nach einem vollen Jahr ununterbrochener Beschäftigung den regulären Jahresanspruch von 30 Tagen.",
      },
      {
        id: "urlaub-policy-de#c2",
        page: 1,
        text: "Nicht genutzte Urlaubstage können in das nächste Kalenderjahr übertragen werden, bis zu einer maximalen Übertragungsgrenze von 10 Tagen. Ein darüber hinausgehendes Guthaben verfällt am 1. Januar.",
      },
    ],
  },

  // --- abstention axis: names a topic, contains no substantive answer ---
  {
    sourcePath: "/data/absent-topic-pointer.md",
    file: "absent-topic-pointer.md",
    chunks: [
      {
        id: "absent-topic-pointer#c1",
        page: 1,
        text: "This index lists the HR policy sections maintained by the People Operations team, including travel & expense, vacation, onboarding, data retention, and parental leave.",
      },
      {
        id: "absent-topic-pointer#c2",
        page: 1,
        text: "For detailed policy text, consult the relevant handbook section directly; this index page provides section titles only and is updated quarterly by People Operations.",
      },
    ],
  },

  // --- happy-path axis: plain, unambiguous document, no adjacent trap ---
  {
    sourcePath: "/data/it-equipment-policy.md",
    file: "it-equipment-policy.md",
    chunks: [
      {
        id: "it-equipment-policy#c1",
        page: 1,
        text: "Northwind issues each full-time employee a standard-configuration laptop upon hire, replaced on a 3-year refresh cycle managed by the IT helpdesk.",
      },
      {
        id: "it-equipment-policy#c2",
        page: 1,
        text: "Employees who need non-standard equipment, such as a second monitor or specialized peripherals, must submit a request through the IT service desk portal with manager approval.",
      },
    ],
  },

  // --- freshness axis (#858): a current certificate and its expired archived
  //     copy, both answering the "AFNOR certification" question. The archived
  //     copy sits under an OLD/ segment, so statusForPath (archive-paths.ts)
  //     seeds it as `archived` — default retrieval must return only the
  //     current cert, and citing the 2013-expired one is the exact dangerous
  //     answer the 2026-07-14 Noack live test surfaced.
  {
    sourcePath: "/data/quality/afnor-certificate-2024.md",
    file: "quality/afnor-certificate-2024.md",
    chunks: [
      {
        id: "quality/afnor-certificate-2024#c1",
        page: 1,
        text: "The Northwind microbiology laboratory holds a valid AFNOR NF VALIDATION certificate for its Petrifilm enumeration methods, certificate number NF-2024-0417, issued in January 2024 and valid through December 2027.",
      },
    ],
  },
  {
    sourcePath: "/data/quality/OLD/afnor-certificate-2013.md",
    file: "quality/OLD/afnor-certificate-2013.md",
    chunks: [
      {
        id: "quality/OLD/afnor-certificate-2013#c1",
        page: 1,
        text: "This archived record documents the Northwind microbiology laboratory's AFNOR NF VALIDATION certificate number NF-2013-0092, issued in March 2013. This certificate expired in December 2016 and is retained for historical reference only.",
      },
    ],
  },

  // --- crowding axis (#858): a clean single-topic datasheet vs. a compilation
  //     binder that reworded the same Petrifilm incubation fact among many
  //     unrelated sections. Without the per-document crowding cap the binder's
  //     chunks can dominate the result list and the citation points at the
  //     binder instead of the datasheet.
  {
    sourcePath: "/data/petrifilm-datasheet.md",
    file: "petrifilm-datasheet.md",
    chunks: [
      {
        id: "petrifilm-datasheet#c1",
        page: 1,
        text: "The Petrifilm Aerobic Count Plate is a ready-made culture medium for enumerating aerobic bacteria in food and water samples. Inoculate the plate with 1 mL of sample and spread with the flat side of the spreader.",
      },
      {
        id: "petrifilm-datasheet#c2",
        page: 1,
        text: "Incubate Petrifilm Aerobic Count Plates at 32 degrees Celsius for 48 hours, then count the red colonies to determine the aerobic plate count. Store unused plates in a freezer at minus 15 degrees Celsius.",
      },
    ],
  },
  {
    sourcePath: "/data/quality-binder.md",
    file: "quality-binder.md",
    chunks: [
      {
        id: "quality-binder#c1",
        page: 1,
        text: "Section 1 — Sample intake. Water and food samples are logged on arrival with a unique accession number, refrigerated at 4 degrees Celsius, and processed within 24 hours of receipt to preserve microbial counts.",
      },
      {
        id: "quality-binder#c2",
        page: 1,
        text: "Section 2 — Media preparation. Prepared agar plates are checked for sterility by incubating a sample of each batch overnight before use. Expired or contaminated media are discarded per the disposal SOP.",
      },
      {
        id: "quality-binder#c3",
        page: 1,
        text: "Section 3 — Aerobic enumeration. For aerobic count determinations the laboratory uses Petrifilm plates; these are incubated at 32 degrees Celsius for 48 hours and the resulting red colonies are counted. This restates the datasheet method for the binder's readers.",
      },
      {
        id: "quality-binder#c4",
        page: 1,
        text: "Section 4 — Equipment calibration. The incubators are calibrated quarterly against a traceable reference thermometer, and the balance is verified daily with certified check weights.",
      },
      {
        id: "quality-binder#c5",
        page: 1,
        text: "Section 5 — Records retention. Completed bench sheets are retained for five years and archived to the OLD folder once superseded by a newer revision.",
      },
    ],
  },
];
