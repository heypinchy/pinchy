import { describe, it, expect } from "vitest";
import { detectLang } from "@/lib/knowledge/lid";

describe("detectLang", () => {
  it('classifies "This is English text" as en', () => {
    expect(detectLang("This is English text")).toBe("en");
  });

  it('classifies "Dies ist deutscher Text" as de', () => {
    expect(detectLang("Dies ist deutscher Text")).toBe("de");
  });

  it("classifies a clearly-German sentence with umlauts as de", () => {
    const text =
      "Die Übersicht über die Größe der Fußgängerzone ist nicht öffentlich verfügbar, aber wir können das prüfen.";
    expect(detectLang(text)).toBe("de");
  });

  it("classifies a clearly-English sentence as en", () => {
    const text =
      "The quick brown fox jumps over the lazy dog, and this is a longer sentence for the detector to work with.";
    expect(detectLang(text)).toBe("en");
  });

  it("classifies a clear French sentence as fr", () => {
    const text = "C'est une phrase en français avec beaucoup de mots et des accents comme é and è.";
    expect(detectLang(text)).toBe("fr");
  });

  it("classifies a clear Spanish sentence as es", () => {
    const text = "Esta es una oración en español con muchas palabras y algunos acentos como ñ y á.";
    expect(detectLang(text)).toBe("es");
  });

  it("classifies a clear Italian sentence as it", () => {
    const text = "Questa è una frase in italiano con molte parole e alcuni accenti come è e più.";
    expect(detectLang(text)).toBe("it");
  });

  it('returns "und" for an empty string', () => {
    expect(detectLang("")).toBe("und");
  });

  it('returns "und" for a 1-2 word ambiguous token', () => {
    expect(detectLang("OK")).toBe("und");
  });

  it('returns "und" for whitespace-only input', () => {
    expect(detectLang("   \n\t  ")).toBe("und");
  });

  it('returns "und" for a mixed/garbage string with no stopword hits', () => {
    expect(detectLang("xk7qz vroom zzyx blorp 42 ###@@@ qwxz")).toBe("und");
  });
});
