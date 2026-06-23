import { describe, it, expect } from "vitest";
import { neutralizeFormula, csvField, csvEscape } from "@/lib/csv";

describe("neutralizeFormula", () => {
  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "prefixes a value starting with %j with a single quote",
    (trigger) => {
      const out = neutralizeFormula(`${trigger}HYPERLINK("http://evil")`);
      expect(out.startsWith("'")).toBe(true);
    }
  );

  it("leaves an ordinary value untouched", () => {
    expect(neutralizeFormula("Alice Carter")).toBe("Alice Carter");
  });

  it("only inspects the first character", () => {
    expect(neutralizeFormula("a=b+c")).toBe("a=b+c");
  });

  it("leaves an empty string untouched", () => {
    expect(neutralizeFormula("")).toBe("");
  });
});

describe("csvField (always quoted)", () => {
  it("neutralizes a formula trigger and still wraps in quotes", () => {
    expect(csvField("=cmd")).toBe(`"'=cmd"`);
  });

  it("escapes embedded quotes", () => {
    expect(csvField('a"b')).toBe(`"a""b"`);
  });
});

describe("csvEscape (conditional quoting)", () => {
  it("neutralizes a formula trigger even when no comma/quote/newline is present", () => {
    // The formula guard must run regardless of the RFC-4180 wrap condition: a
    // =... value with no comma must still be neutralized to text.
    expect(csvEscape("=1+1")).toBe("'=1+1");
  });

  it("wraps when a comma is present", () => {
    expect(csvEscape("a,b")).toBe(`"a,b"`);
  });

  it("leaves a plain value unwrapped", () => {
    expect(csvEscape("gpt-4o")).toBe("gpt-4o");
  });
});
