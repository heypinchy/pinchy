import { describe, expect, it } from "vitest";

import { detectQuestionLanguage } from "./question-language";

describe("detectQuestionLanguage", () => {
  it.each([
    [
      "Jaka jest maksymalna temperatura powierzchni WT-450 podczas próbnej eksploatacji? Podaj źródło.",
      "Polish",
    ],
    // A general-purpose detector (franc) reads this one as Czech. Naming the
    // wrong language is worse than naming none, so it is pinned here.
    ["Kto podpisał protokół odbioru AP-2023-091?", "Polish"],
    ["Do jakiej kwoty zwracane są koszty noclegu podczas podróży służbowej do Wiednia?", "Polish"],
    ["Chi ha firmato il verbale di collaudo AP-2023-091?", "Italian"],
    ["Ogni quante ore di funzionamento va eseguita la manutenzione della pompa P7?", "Italian"],
    ["What was the maximum surface temperature of the WT-450 during the trial run?", "English"],
    ["Who signed the acceptance protocol?", "English"],
    ["Wie hoch war der Druckverlust des WT-450 im Primärkreislauf?", "German"],
    ["Wer hat das Abnahmeprotokoll unterschrieben?", "German"],
    ["Quelle est la température maximale du WT-450 pendant l'essai ?", "French"],
    ["¿Quién firmó el protocolo de aceptación?", "Spanish"],
    ["Wie heeft het protocol ondertekend en wanneer was de keuring?", "Dutch"],
    ["Kdo podepsal předávací protokol a kdy proběhla zkouška?", "Czech"],
    ["Quem assinou o protocolo de aceitação e quando foi feito?", "Portuguese"],
  ])("names the language of %j", (question, expected) => {
    expect(detectQuestionLanguage(question)).toBe(expected);
  });

  it("names no language when the message has no signal", () => {
    // A bare product code or a one-word message cannot tell a language apart,
    // and a guess here is what the caller then states as fact.
    expect(detectQuestionLanguage("AP-2023-091?")).toBeNull();
    expect(detectQuestionLanguage("WT-450")).toBeNull();
    expect(detectQuestionLanguage("")).toBeNull();
  });

  it("names no language for one it does not know, rather than the nearest one", () => {
    expect(detectQuestionLanguage("Ki írta alá az átvételi jegyzőkönyvet?")).toBeNull();
  });

  it("ignores quoted wording, which is in the documents' language", () => {
    expect(
      detectQuestionLanguage(
        "Co znaczy „Die Abnahme ist mit der Unterschrift abgeschlossen“ w tym dokumencie?"
      )
    ).toBe("Polish");
  });

  it.each([
    "Summarize the Qualitätshandbuch",
    "Explain the Gefährdungsbeurteilung",
    "Any news on the Größenprüfung?",
  ])("doesn't let one German document name outvote an English question: %j", (question) => {
    // People who ask in English about German documents are who #1296 is for.
    // A letter counts only for a language that also has a function word.
    expect(detectQuestionLanguage(question)).not.toBe("German");
  });

  it("doesn't read a Polish personal name as a Polish question", () => {
    expect(detectQuestionLanguage("Show me Łukasz's report")).not.toBe("Polish");
  });

  it("reads past the attachment block Pinchy appends to a message", () => {
    // The block is English markup with workspace paths. Left in, it reads as
    // English and outvotes a short German or Polish question.
    const block =
      "\n\n<pinchy:attachments>\n- `/root/.openclaw/workspaces/a1/uploads/wartung.pdf` (application/pdf, 1.2 MB) — analyze with `pinchy_read`\n</pinchy:attachments>";
    expect(detectQuestionLanguage(`Was steht in dieser Datei zur Wartung?${block}`)).toBe("German");
    expect(detectQuestionLanguage(`Kto podpisał ten protokół?${block}`)).toBe("Polish");
  });

  it.each([
    "Explain the Richtlinie zur Gefährdungsbeurteilung",
    "Summarize the Handbuch für Qualität",
    "Summarize Bericht über die Prüfung",
  ])("doesn't read a German title with its own function words as German: %j", (question) => {
    // Titles bring their prepositions and articles with them. The question's
    // opening word is the asker's, so it weighs more than words inside a title.
    expect(detectQuestionLanguage(question)).not.toBe("German");
  });

  it.each([
    ["Opisz procedurę odbioru", "Polish"],
    ["Podaj wymagania dotyczące pompy P7", "Polish"],
    ["Proszę o podsumowanie protokołu odbioru", "Polish"],
    ["Fasse das Prüfprotokoll zusammen", "German"],
    ["Riassumi il verbale di collaudo", "Italian"],
    ["Summarize the acceptance protocol", "English"],
  ])("names a request that opens with an imperative: %j", (question, expected) => {
    expect(detectQuestionLanguage(question)).toBe(expected);
  });
});
