import { describe, expect, it } from "vitest";
import { stripHtml } from "../email-adapter";

// A mail body is untrusted and reaches stripHtml in full. Lazy regexes rescan
// the rest of the input from every unclosed opener (quadratic: 32k `<script `
// openers blocked the OpenClaw gateway for ~6 s). Count the work rather than
// time it: every character String.prototype.indexOf scans.
function scannedChars(input: string): number {
  const original = String.prototype.indexOf;
  let total = 0;
  String.prototype.indexOf = function (this: string, needle: string, from = 0) {
    const r = original.call(this, needle, from);
    total += (r === -1 ? this.length : r) - from;
    return r;
  };
  try {
    stripHtml(input);
  } finally {
    String.prototype.indexOf = original;
  }
  return total;
}

describe("stripHtml on hostile mail bodies", () => {
  it.each(["<script ", "<SCRIPT ", "<style ", "<style>", "<script>", "<!-- ", "<a ", "<p "])(
    "scans each character a bounded number of times for %j openers",
    (opener) => {
      const input = opener.repeat(4_000);
      expect(scannedChars(input)).toBeLessThanOrEqual(4 * input.length);
    }
  );

  it("finishes a quarter-megabyte of unclosed openers inside a coarse ceiling", () => {
    const input = "<script ".repeat(32_000);
    const t = performance.now();
    stripHtml(input);
    expect(performance.now() - t).toBeLessThan(2_000);
  });

  it("still strips scripts, styles, comments and tags", () => {
    expect(
      stripHtml(
        "<p>a</p><script>x<b></script><style>p{}</style><!--[if mso]>m<![endif]--><b>b&nbsp;&amp;</b><p>c</p>"
      )
    ).toBe("a\nb &\nc");
  });

  it("recognises <style> after a character whose lowercase is longer (İ)", () => {
    expect(stripHtml("İstanbul İzmir<style>.a{color:red}</style><p>Hallo</p>")).toBe(
      "İstanbul İzmir\nHallo"
    );
  });

  it("keeps a literal < in text instead of eating up to the next tag", () => {
    expect(stripHtml("1 < 2 and 3<br>4")).toBe("1 < 2 and 3\n4");
    expect(stripHtml("1 < 2 and 3<span>4</span>")).toBe("1 < 2 and 3 4");
  });
});
