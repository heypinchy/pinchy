/**
 * Guards the WIRING of the source-link plugin, which its own unit tests
 * structurally cannot.
 *
 * `source-links.test.ts` calls the transformer directly — `remarkSourceLinks({
 * agentId })(tree)` — and passes whether or not the plugin is registered
 * correctly. unified expects an ATTACHER: a function it calls with the options
 * to obtain the transformer. Hand it the transformer instead and TypeScript is
 * satisfied (both are functions), the unit tests stay green, and every chat
 * message fails to render with "Cannot read properties of undefined (reading
 * 'type')" — because unified called the transformer with the options as its
 * tree, then walked `undefined`. That shipped once.
 *
 * So this test applies the plugin list the way unified does, and asserts the
 * result is a transformer that actually transforms.
 */
import { describe, it, expect } from "vitest";

import { buildRemarkPlugins } from "@/components/assistant-ui/markdown-text";

type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] };
type Transformer = (tree: MdastNode) => void;

/**
 * The part of unified's plugin protocol this test depends on: an entry is
 * either a bare attacher or an `[attacher, options]` pair; the attacher is
 * CALLED, with the processor as `this`, and MAY return a transformer (remarkGfm
 * returns none — it only registers micromark extensions through `this.data()`).
 *
 * Reimplemented here rather than mocked, so a wrongly-registered plugin fails
 * the way it fails in the browser instead of the way a stand-in decides to.
 */
function applyPlugins(plugins: unknown): Transformer[] {
  const data: Record<string, unknown> = {};
  const processor = {
    data(key?: string, value?: unknown) {
      if (key === undefined) return data;
      if (value === undefined) return data[key];
      data[key] = value;
      return this;
    },
  };

  const entries = plugins as Array<unknown>;
  return entries
    .map((entry) => {
      const [attacher, options] = Array.isArray(entry) ? entry : [entry, undefined];
      return (attacher as (this: unknown, opts?: unknown) => Transformer | undefined).call(
        processor,
        options
      );
    })
    .filter((transform): transform is Transformer => typeof transform === "function");
}

function paragraph(text: string): MdastNode {
  return {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
  };
}

function firstLink(tree: MdastNode): MdastNode | null {
  if (tree.type === "link") return tree;
  for (const child of tree.children ?? []) {
    const found = firstLink(child);
    if (found) return found;
  }
  return null;
}

describe("buildRemarkPlugins", () => {
  it("registers the source-link plugin so unified can attach it and it rewrites a citation", () => {
    const transformers = applyPlugins(buildRemarkPlugins("agent-1"));
    const tree = paragraph("- [1] /data/noack/PPR/document.pdf — p. 510");

    // Every transformer runs, exactly as it would during a real render. If the
    // list carried a transformer instead of an attacher, `applyPlugins` above
    // would already have produced garbage and this call would throw.
    for (const transform of transformers) transform(tree);

    const link = firstLink(tree);
    expect(link).not.toBeNull();
    expect(link!.url).toBe(
      "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FPPR%2Fdocument.pdf#page=510"
    );
  });

  it("leaves the citation as plain text when there is no agent to scope the link to", () => {
    // An href without an agent id cannot resolve to anything the route would
    // authorize, so no link is better than a broken one.
    const transformers = applyPlugins(buildRemarkPlugins(null));
    const tree = paragraph("- [1] /data/noack/PPR/document.pdf — p. 510");

    for (const transform of transformers) transform(tree);

    expect(firstLink(tree)).toBeNull();
  });
});
