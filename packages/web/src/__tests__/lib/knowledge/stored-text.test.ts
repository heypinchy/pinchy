import { describe, expect, it } from "vitest";
import { isContentRejection, toStorableLocator, toStorableText } from "@/lib/knowledge/stored-text";

describe("toStorableText", () => {
  it("removes NUL, which Postgres text and jsonb cannot hold", () => {
    expect(toStorableText("Rech\u0000nung")).toBe("Rechnung");
  });

  it("turns the other C0 control characters into a space, so words stay apart", () => {
    expect(toStorableText("goods.\u0001Valid\u001funtil\u000bnow\u000cand\u007fthen")).toBe(
      "goods. Valid until now and\u007fthen"
    );
  });

  it("keeps tab, line feed and carriage return, which chunking reads", () => {
    expect(toStorableText("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
  });

  it("returns ordinary text unchanged", () => {
    const text = "Prüfbericht – Größe 12 µm, 100 % geprüft 🙂";
    expect(toStorableText(text)).toBe(text);
  });
});

describe("toStorableLocator", () => {
  it("cleans a sheet name", () => {
    expect(
      toStorableLocator({ kind: "sheet", sheet: "Supp\u0000liers", startRow: 1, endRow: 4 })
    ).toEqual({ kind: "sheet", sheet: "Suppliers", startRow: 1, endRow: 4 });
  });

  it("cleans every heading of a heading path", () => {
    expect(
      toStorableLocator({ kind: "heading", headings: ["Intro\u0000", "Scope\u0002x"] })
    ).toEqual({ kind: "heading", headings: ["Intro", "Scope x"] });
  });

  it("leaves page, slide and missing locators alone", () => {
    expect(toStorableLocator({ kind: "page", page: 3 })).toEqual({ kind: "page", page: 3 });
    expect(toStorableLocator({ kind: "slide", slide: 2 })).toEqual({ kind: "slide", slide: 2 });
    expect(toStorableLocator(null)).toBeNull();
  });
});

describe("isContentRejection", () => {
  const pgError = (code: string) => Object.assign(new Error("refused"), { code });

  it("finds the database's refusal behind the query wrapper", () => {
    const inner = pgError("22021");
    const wrapped = new Error("Failed query: insert …", { cause: inner });
    expect(isContentRejection(wrapped)).toBe(inner);
  });

  it.each(["22000", "22P05", "23505", "54000"])(
    "treats SQLSTATE %s as a refusal of this content",
    (code) => {
      expect(isContentRejection(pgError(code))).not.toBeNull();
    }
  );

  it.each(["08006", "53300", "57P01", "40001", "XX000"])(
    "treats SQLSTATE %s as a problem of the database, not of the file",
    (code) => {
      expect(isContentRejection(pgError(code))).toBeNull();
    }
  );

  it("treats an error without a SQLSTATE as systemic", () => {
    expect(isContentRejection(new Error("connect ECONNREFUSED"))).toBeNull();
    expect(isContentRejection(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(isContentRejection("boom")).toBeNull();
  });

  it("stops on a cause chain that loops", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(isContentRejection(a)).toBeNull();
  });
});
