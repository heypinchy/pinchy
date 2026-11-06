import { describe, expect, it } from "vitest";

import { gradeAnswerLanguage, sentenceLanguages } from "../answer-language";

describe("gradeAnswerLanguage", () => {
  // The two answers from #1296, verbatim up to the elided citation detail.
  // They are the reason this grader exists, so they are its first fixtures.
  it("fails a German answer to a Polish question", () => {
    const answer =
      "Die maximale Oberflächentemperatur des WT-450 im Probebetrieb betrug **84,6 °C** [1]. " +
      "Der Wert wurde bei Volllast nach 6 Stunden gemessen.\n\n" +
      "**Sources:**\n\n- [1] Pruefberichte/WT-450-Probebetrieb.md — § Messergebnisse";
    const verdict = gradeAnswerLanguage(answer, "pl");
    expect(verdict.passed).toBe(false);
    expect(verdict.found).toContain("de");
  });

  it("fails an answer that starts in Polish and switches to German mid-sentence", () => {
    const answer =
      "Protokół Abnahmeprotokoll Nr. AP-2023-091 ist mit **Ing. Huber** unterzeichnet [1].";
    expect(gradeAnswerLanguage(answer, "pl").passed).toBe(false);
  });

  it("passes a Polish answer that keeps a German document title and quote as written", () => {
    const answer =
      "Maksymalna temperatura powierzchni WT-450 podczas próbnej eksploatacji wynosiła " +
      "**84,6 °C** [1]. Pomiar wykonano przy pełnym obciążeniu, po 6 godzinach pracy, " +
      "zgodnie z dokumentem „Prüfbericht Probebetrieb WT-450“ [1].\n\n" +
      "**Sources:**\n\n- [1] Pruefberichte/WT-450-Probebetrieb.md — § Messergebnisse";
    const verdict = gradeAnswerLanguage(answer, "pl");
    expect(verdict.passed).toBe(true);
    expect(verdict.found).toEqual(["pl"]);
  });

  it("does not read the Sources list or its German paths as part of the answer", () => {
    const answer =
      "The protocol was signed by Ing. Huber on behalf of the customer [1].\n\n" +
      "**Sources:**\n\n" +
      "- [1] Abnahme/Abnahmeprotokoll-AP-2023-091.md — § Unterschriften der Vertragsparteien und Bestätigung der Abnahme";
    expect(gradeAnswerLanguage(answer, "en").passed).toBe(true);
  });

  it("strips a German quote that opens with „ and closes with a plain double quote", () => {
    // Captured from a Haiku 5.5 run: a Polish answer whose German quotes open
    // with the German low mark and close with an ASCII quote.
    const answer =
      "Protokół odbioru **AP-2023-091** podpisali:\n\n" +
      "- **Ing. Thomas Huber** – w imieniu **Auftraggeber** (zamawiającego)\n" +
      "- **Sabine Kern** – w imieniu **Auftragnehmer** (wykonawcy)\n\n" +
      'Dokument mówi: „Das Protokoll wurde für den Auftraggeber von Ing. Thomas Huber und für den Auftragnehmer von Sabine Kern unterzeichnet." [2] ' +
      'Sicherheitsfachkraft werks nie podpisała protokołu, tylko „hat das Protokoll zur Kenntnis genommen" [2].\n\n' +
      "Protokół dotyczy odbioru linii 3 w zakładzie Wels, który odbył się 2 maja 2023 r. [1].\n\n" +
      "**Sources**\n- [1] kb-language/Abnahme/Abnahmeprotokoll_Scan_AP-2023-091.pdf (p. 1)";
    expect(gradeAnswerLanguage(answer, "pl")).toEqual({ passed: true, found: ["pl"] });
  });

  it("passes an Italian answer", () => {
    const answer =
      "Il protocollo di collaudo AP-2023-091 è stato firmato dall'Ing. Huber per il cliente [1]. " +
      "La firma è avvenuta durante il collaudo finale.";
    expect(gradeAnswerLanguage(answer, "it").passed).toBe(true);
  });

  it("fails an empty answer, which is in no language at all", () => {
    const verdict = gradeAnswerLanguage("", "pl");
    expect(verdict.passed).toBe(false);
    expect(verdict.found).toEqual([]);
  });

  it("fails an answer whose only classifiable sentences are in the wrong language", () => {
    // Short Polish fragments with no function words are neutral, so the
    // verdict rests on the German sentence, as it should.
    const answer = "WT-450: 84,6 °C [1]. Der Wert wurde bei Volllast gemessen.";
    expect(gradeAnswerLanguage(answer, "pl").passed).toBe(false);
  });
});

describe("sentenceLanguages", () => {
  it("ignores inline citations, bold markers and quoted wording", () => {
    // Every German word here is inside quotes, so nothing is left to read as
    // German: the sentence is Polish.
    expect(
      sentenceLanguages(
        "Dokument „Die Abnahme ist mit der Unterschrift abgeschlossen“ jest w aktach [2]."
      )
    ).toEqual(["pl"]);
  });

  it("leaves a sentence with too few function words unclassified", () => {
    expect(sentenceLanguages("WT-450: 84,6 °C.")).toEqual([]);
  });
});
