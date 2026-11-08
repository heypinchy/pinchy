import { describe, expect, it } from "vitest";

import { locatePassage } from "@/lib/knowledge/passage-match";

// The page text as pdf.js hands it over: one string per text run, in reading
// order. The server-side extractor (pdf-extract.ts) joined these with spaces and
// newlines to build the chunk text, so the two differ only in whitespace.
const page = [
  "Wartungsvertrag",
  "§ 4 Reaktionszeiten",
  "Der Auftragnehmer reagiert auf Störungen",
  "innerhalb von vier Stunden.",
  "§ 5 Vergütung",
  "Die Pauschale beträgt 1.200 € pro Quartal.",
];

describe("locatePassage", () => {
  it("finds a chunk whose whitespace differs from the text runs", () => {
    const chunk =
      "§ 4 Reaktionszeiten\nDer Auftragnehmer reagiert auf Störungen innerhalb von\nvier Stunden.";
    expect(locatePassage(page, chunk)).toEqual([1, 2, 3]);
  });

  it("finds a chunk spanning the whole page", () => {
    expect(locatePassage(page, page.join(" "))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("includes a run the passage only starts or ends inside", () => {
    // Overlapping chunks begin mid-line; the run that holds the first
    // character is part of the highlight.
    expect(locatePassage(page, "Stunden. § 5 Vergütung Die Pauschale")).toEqual([3, 4, 5]);
  });

  it("falls back to the passage's two ends when its middle differs", () => {
    // An extraction difference in the middle (here: a run the browser reads
    // differently) must not cost the whole highlight.
    const chunk =
      "§ 4 Reaktionszeiten Der Auftragnehmer reagiert auf STOERUNGEN-GEÄNDERT-XYZ " +
      "innerhalb von vier Stunden. § 5 Vergütung";
    expect(locatePassage(page, chunk)).toEqual([1, 2, 3, 4]);
  });

  it("returns null when the passage is not on the page", () => {
    expect(
      locatePassage(page, "Diese Passage steht auf einer ganz anderen Seite des Dokuments.")
    ).toBeNull();
  });

  it("returns null for an empty page or an empty passage", () => {
    expect(locatePassage([], "anything at all here")).toBeNull();
    expect(locatePassage(page, "   \n ")).toBeNull();
  });

  it("does not report a match for a passage too short to be distinctive", () => {
    // "von" occurs on the page, but three letters say nothing about where the
    // passage is — highlighting them would be a guess dressed up as a fact.
    expect(locatePassage(page, "von")).toBeNull();
  });

  it("refuses an anchor match that would span far more than the passage", () => {
    // Head and tail both occur, but so far apart that the region between them
    // cannot be this passage.
    const long = Array.from({ length: 40 }, (_, i) => `Füllzeile Nummer ${i} ohne Bezug.`);
    const runs = ["Anfang des Abschnitts hier", ...long, "und hier das Ende davon"];
    const chunk = "Anfang des Abschnitts hier XXXXXXXX und hier das Ende davon";
    expect(locatePassage(runs, chunk)).toBeNull();
  });
});
