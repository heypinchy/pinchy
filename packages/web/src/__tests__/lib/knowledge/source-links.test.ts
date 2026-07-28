/**
 * The knowledge-base answer names its sources as plain prose, because the
 * Sources list is written by the model — nothing renders it. Three real shapes
 * were observed against the same corpus within one day:
 *
 *   - kimi-k2.6, obeying the template:  `- [2] /data/x/doc.pdf — p. 44`
 *   - kimi-k2.6, embellishing:          `[1] /data/x/doc.pdf – AOAC study, Tabelle 18 …`
 *   - deepseek-v4-pro, its own idea:    `*Quelle: PPR document.pdf, S. 275*`
 *
 * So the transform keys off the ONE thing every shape carries — a path with a
 * known document extension — and never off the surrounding format. Whatever it
 * does not recognise it leaves untouched: the fallback is today's plain text,
 * so a model inventing a fourth shape costs a link, never a broken answer.
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
  it("points at the agent's workspace-file route with the path encoded", () => {
    // Spaces and & are both real in this corpus ("PF LAB/… afnor_update_&_support.pdf")
    // and both break a bare query string, so encoding is not cosmetic.
    const href = buildSourceHref(AGENT, "/data/noack/PF LAB/a & b.pdf", null);
    expect(href).toBe(
      "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FPF%20LAB%2Fa%20%26%20b.pdf"
    );
  });

  it("appends the PDF viewer's page fragment when a page is known", () => {
    const href = buildSourceHref(AGENT, "/data/x/doc.pdf", 44);
    expect(href.endsWith("#page=44")).toBe(true);
  });
});

describe("parseSourceHref", () => {
  it("round-trips a path built by buildSourceHref, so the viewer gets a real title", () => {
    const path = "/data/noack/PF LAB/a & b.pdf";
    expect(parseSourceHref(buildSourceHref(AGENT, path, 44))).toEqual({ path, page: 44 });
  });

  it("reports no page when the href carries none", () => {
    expect(parseSourceHref(buildSourceHref(AGENT, "/data/x/doc.pdf", null))).toEqual({
      path: "/data/x/doc.pdf",
      page: null,
    });
  });

  it("returns null for an ordinary link, which is how a citation is told apart", () => {
    expect(parseSourceHref("https://example.com/doc.pdf")).toBeNull();
  });

  it("survives a malformed escape instead of throwing mid-render", () => {
    expect(parseSourceHref("/api/agents/a/workspace-file?path=%E0%A4%A")).toBeNull();
  });
});

describe("remarkSourceLinks", () => {
  it("links a template-formatted source and keeps its page", () => {
    const tree = run(paragraph("- [2] /data/noack/PPR/document.pdf — p. 44"));
    expect(links(tree)).toEqual([
      {
        url: "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FPPR%2Fdocument.pdf#page=44",
        text: "/data/noack/PPR/document.pdf",
      },
    ]);
  });

  it("links a source buried in prose, where the format collapsed", () => {
    const tree = run(
      paragraph("Quellen: [1] /data/noack/PF RAC/study.pdf – AOAC Performance Tested Method Study")
    );
    const found = links(tree);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe("/data/noack/PF RAC/study.pdf");
  });

  it("reads a German page abbreviation", () => {
    const tree = run(paragraph("Quelle: /data/noack/PPR/document.pdf, S. 275"));
    expect(links(tree)[0].url.endsWith("#page=275")).toBe(true);
  });

  it("keeps the surrounding words as text around the link", () => {
    const tree = run(paragraph("siehe /data/x/doc.pdf für Details"));
    const para = tree.children![0];
    expect(para.children!.map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(para.children![0].value).toBe("siehe ");
    expect(para.children![2].value).toBe(" für Details");
  });

  it("links every source when one line names several", () => {
    const tree = run(paragraph("[1] /data/a/one.pdf — p. 1 [2] /data/b/two.pdf — p. 2"));
    expect(links(tree).map((l) => l.text)).toEqual(["/data/a/one.pdf", "/data/b/two.pdf"]);
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
        { type: "inlineCode", value: "/data/x/doc.pdf" },
        { type: "link", url: "/elsewhere", children: [{ type: "text", value: "/data/x/doc.pdf" }] },
      ],
    };
    run(tree);
    expect(links(tree)).toEqual([{ url: "/elsewhere", text: "/data/x/doc.pdf" }]);
  });

  it("ignores a path whose extension we cannot serve", () => {
    const tree = paragraph("/etc/passwd and /data/x/notes.exe");
    const before = JSON.stringify(tree);
    run(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });
});
