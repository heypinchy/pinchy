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
});
