/**
 * The knowledge-base answer names its sources as plain prose, because the
 * Sources list is written by the model — nothing renders it. Three real shapes
 * were observed against the same corpus within one day:
 *
 *   - kimi-k2.6, obeying the template:  `- [2] noack/x/doc.pdf — p. 44`
 *   - kimi-k2.6, embellishing:          `[1] noack/x/doc.pdf – AOAC study, Tabelle 18 …`
 *   - deepseek-v4-pro, its own idea:    `*Quelle: PPR document.pdf, S. 275*`
 *
 * So the transform keys off the ONE thing every shape carries — a path with a
 * known document extension — and never off the surrounding format. Whatever it
 * does not recognise it leaves untouched: the fallback is today's plain text,
 * so a model inventing a fourth shape costs a link, never a broken answer.
 *
 * The paths are DATA-ROOT-RELATIVE, because that is what `knowledge_search`
 * shows the model and the model can only cite what it is shown (#933). The href
 * carries the absolute path the route needs — `citation-path.ts` is the single
 * place that converts between the two, in both directions.
 */
import { describe, it, expect } from "vitest";

import { remarkSourceLinks, buildSourceHref, parseSourceHref } from "@/lib/knowledge/source-links";

/** Minimal mdast subset — the plugin only ever walks children and rewrites text nodes. */
type Node = { type: string; value?: string; url?: string; children?: Node[] };

function paragraph(text: string): Node {
  return {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
  };
}

/** Collects every link node in tree order, so assertions read as "what became clickable". */
function links(tree: Node): Array<{ url: string; text: string }> {
  const found: Array<{ url: string; text: string }> = [];
  const walk = (node: Node) => {
    if (node.type === "link" && node.url) {
      found.push({ url: node.url, text: (node.children ?? []).map((c) => c.value ?? "").join("") });
    }
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
  return found;
}

const AGENT = "agent-1";
const run = (tree: Node) => {
  remarkSourceLinks({ agentId: AGENT })(tree as never);
  return tree;
};

describe("buildSourceHref", () => {
  it("points at the agent's workspace-file route with the ABSOLUTE path encoded", () => {
    // The citation is relative; the route opens a file, so the href has to
    // carry the path the filesystem answers to. Spaces and & are both real in
    // this corpus ("PF LAB/… afnor_update_&_support.pdf") and both break a bare
    // query string, so encoding is not cosmetic either.
    const href = buildSourceHref(AGENT, "noack/PF LAB/a & b.pdf", null);
    expect(href).toBe(
      "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FPF%20LAB%2Fa%20%26%20b.pdf"
    );
  });

  it("appends the PDF viewer's page fragment when a page is known", () => {
    const href = buildSourceHref(AGENT, "x/doc.pdf", 44);
    expect(href.endsWith("#page=44")).toBe(true);
  });

  it("cannot be talked out of the data root by a fabricated citation", () => {
    // The path comes from model output. This is the outer of two gates — the
    // route still resolves the result against the agent's allowed_paths — but a
    // fabricated citation must not even be SHAPED into an escape.
    expect(buildSourceHref(AGENT, "../../etc/passwd.pdf", null)).toBe(
      "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fetc%2Fpasswd.pdf"
    );
  });
});

describe("parseSourceHref", () => {
  it("round-trips a path built by buildSourceHref, so the viewer gets a real title", () => {
    // Round-trips to the CITATION path, not the absolute one: this value is the
    // viewer's title, and a title reading "/data/noack/…" would put the
    // container path back in front of the reader that #933 took out of it.
    const path = "noack/PF LAB/a & b.pdf";
    expect(parseSourceHref(buildSourceHref(AGENT, path, 44))).toEqual({ path, page: 44 });
  });

  it("reports no page when the href carries none", () => {
    expect(parseSourceHref(buildSourceHref(AGENT, "x/doc.pdf", null))).toEqual({
      path: "x/doc.pdf",
      page: null,
    });
  });

  it("returns null for an ordinary link, which is how a citation is told apart", () => {
    expect(parseSourceHref("https://example.com/doc.pdf")).toBeNull();
  });

  it("survives a malformed escape instead of throwing mid-render", () => {
    expect(parseSourceHref("/api/agents/a/workspace-file?path=%E0%A4%A")).toBeNull();
  });

  it.each([
    "https://evil.example/workspace-file?path=%2Fx.pdf",
    "//evil.example/workspace-file?path=%2Fx.pdf",
    "http://localhost:1234/workspace-file?path=%2Fx.pdf",
    "https://evil.example/api/agents/a1/workspace-file?path=%2Fx.pdf",
  ])("refuses the foreign origin %j instead of embedding it", (href) => {
    // The answer this renders is MODEL output, and a knowledge base ingests
    // documents an attacker may have authored — so "the model wrote it" is not
    // a trust boundary. Recognising a citation by an unanchored substring let
    // any absolute url carrying `/workspace-file?path=` through, and the
    // renderer hands what it recognises to <embed src>. There is no CSP to
    // catch that downstream, so the check has to be here: a citation is a
    // same-origin path under /api/agents/, or it is not a citation.
    expect(parseSourceHref(href)).toBeNull();
  });
});

describe("remarkSourceLinks", () => {
  it("links a template-formatted source and keeps its page", () => {
    const tree = run(paragraph("- [2] noack/PPR/document.pdf — p. 44"));
    expect(links(tree)).toEqual([
      {
        url: "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FPPR%2Fdocument.pdf#page=44",
        text: "noack/PPR/document.pdf",
      },
    ]);
  });

  it("links a source buried in prose, where the format collapsed", () => {
    const tree = run(
      paragraph("Quellen: [1] noack/PF RAC/study.pdf – AOAC Performance Tested Method Study")
    );
    const found = links(tree);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe("noack/PF RAC/study.pdf");
  });

  it("reads a German page abbreviation", () => {
    const tree = run(paragraph("Quelle: noack/PPR/document.pdf, S. 275"));
    expect(links(tree)[0].url.endsWith("#page=275")).toBe(true);
  });

  it("keeps the surrounding words as text around the link", () => {
    const tree = run(paragraph("siehe x/doc.pdf für Details"));
    const para = tree.children![0];
    expect(para.children!.map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(para.children![0].value).toBe("siehe ");
    expect(para.children![2].value).toBe(" für Details");
  });

  it("links every source when one line names several", () => {
    const tree = run(paragraph("[1] a/one.pdf — p. 1 [2] b/two.pdf — p. 2"));
    expect(links(tree).map((l) => l.text)).toEqual(["a/one.pdf", "b/two.pdf"]);
  });

  it("leaves text without a document path completely alone", () => {
    // The fallback that makes this safe to ship: no match, no rewrite.
    const tree = paragraph("Die Nachweisgrenze hängt vom Verdünnungsfaktor ab.");
    const before = JSON.stringify(tree);
    run(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("does not rewrite inside code or an existing link", () => {
    // A path inside `code` is being shown, not referenced; a path already inside
    // a link would nest an <a> in an <a>, which React drops on the floor.
    const tree: Node = {
      type: "root",
      children: [
        { type: "inlineCode", value: "x/doc.pdf" },
        { type: "link", url: "/elsewhere", children: [{ type: "text", value: "x/doc.pdf" }] },
      ],
    };
    run(tree);
    expect(links(tree)).toEqual([{ url: "/elsewhere", text: "x/doc.pdf" }]);
  });

  it("ignores a path whose extension we cannot serve", () => {
    const tree = paragraph("/etc/passwd and x/notes.exe");
    const before = JSON.stringify(tree);
    run(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("links a url-shaped path the same way, because the route decides access", () => {
    // remark-gfm turns a real `https://…` url into a link node before this
    // plugin runs, so it never sees one. What DOES reach here is a bare
    // `example.com/docs/manual.pdf`, which gfm does not autolink. Linking it is
    // harmless — the route resolves it against allowed_paths and 403s — but it
    // should be a decision on record, not an accident.
    const tree = run(paragraph("siehe example.com/docs/manual.pdf"));
    expect(links(tree).map((l) => l.text)).toEqual(["example.com/docs/manual.pdf"]);
  });

  it("does not link a bare filename, which names no findable document", () => {
    // A citation shortened to a basename is the failure a path exists to
    // prevent — unfindable in a deep tree, ambiguous across folders. Linking it
    // would dress that failure up as a working reference.
    const tree = paragraph("siehe report.pdf für Details");
    const before = JSON.stringify(tree);
    run(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("treats an absolute path a model invented as just another citation path", () => {
    // Nothing shows the model an absolute path any more, so one appearing in an
    // answer is fabricated or copied from elsewhere. It resolves under the data
    // root like everything else and 403s there — a decision on record, not a
    // second code path.
    const tree = run(paragraph("siehe /data/x/doc.pdf hier"));
    expect(links(tree).map((l) => l.text)).toEqual(["data/x/doc.pdf"]);
  });

  it("keeps the path intact when earlier text case-folds to a different length", () => {
    // Finding the extension case-insensitively must not be done by lowercasing
    // the whole node and indexing into the original: "İ".toLowerCase() is TWO
    // characters, so every offset after it shifts by one and the extracted path
    // silently loses its first character. A German lab corpus with a Turkish
    // name in a sentence is enough to hit it.
    const tree = run(paragraph("İ siehe x/doc.PDF hier"));
    expect(links(tree).map((l) => l.text)).toEqual(["x/doc.PDF"]);
  });

  it("reads a doubled extension as the shorter path", () => {
    // `/x.pdf.pdf` is ambiguous and neither reading is more correct. It is
    // pinned only so the windowed scan below cannot change it unnoticed: the
    // scan stops at the FIRST `.pdf` that a path can legally end on, where the
    // earlier unbounded regex kept expanding across it.
    const tree = run(paragraph("x/report.pdf.pdf"));
    expect(links(tree).map((l) => l.text)).toEqual(["x/report.pdf"]);
  });

  describe("pathological input", () => {
    /**
     * This transform runs SYNCHRONOUSLY IN THE BROWSER, on every streamed
     * chunk of every message — so a slow parse is a frozen chat, not a slow
     * request. The original pattern scanned the whole text node with nested
     * lazy quantifiers, which backtracks catastrophically on path-shaped text
     * that never completes a match: the three shapes below each took 6-7
     * SECONDS at this size, and grow superlinearly from there.
     *
     * The budget is deliberately loose (a second, where the fixed
     * implementation needs well under a millisecond) so this measures the
     * difference between "linear" and "catastrophic" rather than the speed of
     * the machine it runs on. It cannot flake into red on a loaded runner
     * without the regression being real.
     */
    const BUDGET_MS = 1000;

    it.each([
      ["path-shaped text with no extension at all", "/" + "a/".repeat(6000) + "b".repeat(6000)],
      ["an extension the lookahead rejects", "/" + "a/".repeat(6000) + "b".repeat(6000) + ".pdfX"],
      ["many near-misses in one node", ("/" + "a/".repeat(20) + "b.pdfX ").repeat(300)],
    ])("finishes %s in linear time", (_label, text) => {
      const tree = paragraph(text);
      const before = JSON.stringify(tree);

      const started = performance.now();
      run(tree);
      const elapsed = performance.now() - started;

      expect(JSON.stringify(tree)).toBe(before);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  });
});
