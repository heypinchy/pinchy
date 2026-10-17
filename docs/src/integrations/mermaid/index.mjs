/**
 * Renders ```mermaid code blocks as diagrams.
 *
 * Replaces @pasqal-io/starlight-client-mermaid, which stopped working under
 * astro 7 (#851) without failing anything: it registered its transform through
 * `markdown.remarkPlugins`, and astro 7's default Markdown processor (Sätteri)
 * does not run remark plugins. The diagram's source shipped as a code block.
 *
 * So the transform goes where astro 7 actually reads it — onto
 * `config.markdown.processor`, the same object Starlight and Expressive Code
 * extend and @astrojs/mdx later compiles `.mdx` with. It runs at the mdast
 * level, before Expressive Code (a hast plugin) ever sees the block, and turns
 * it into `<div class="mermaid" data-content="…">`; the MarkdownContent
 * override next to this file renders that container in the browser.
 *
 * `pnpm -C docs check:diagrams` proves the result in dist/. Do not trust a
 * green build for this — the failure above was a green build.
 */

const CLASS_NAME = "mermaid";

/** Sätteri mdast plugin: a ```mermaid code node becomes an empty container. */
export const mermaidMdastPlugin = {
  name: "pinchy-mermaid",
  code(node) {
    if (node.lang !== "mermaid") return;
    return {
      type: "paragraph",
      data: {
        hName: "div",
        hProperties: {
          class: CLASS_NAME,
          "data-content": node.value,
          "data-status": "loading",
        },
      },
      children: [],
    };
  },
};

/**
 * Registers the transform on the configured Markdown processor.
 *
 * Throws on any processor it does not know how to extend: a silent skip here
 * is exactly the failure this module exists to replace.
 */
export function registerMermaidTransform(processor) {
  if (processor?.name !== "satteri") {
    throw new Error(
      `[pinchy-mermaid] cannot register on markdown.processor "${processor?.name}". ` +
        "Only Sätteri (astro 7's default) is supported — extend src/integrations/mermaid/index.mjs " +
        "before switching processors, or every Mermaid diagram ships as a code block.",
    );
  }
  processor.options.mdastPlugins.push(mermaidMdastPlugin);
}

/** @returns {import("@astrojs/starlight/types").StarlightPlugin} */
export default function starlightMermaid() {
  return {
    name: "pinchy-mermaid",
    hooks: {
      "config:setup"({ config, updateConfig, addIntegration }) {
        if (config.components?.MarkdownContent) {
          throw new Error(
            "[pinchy-mermaid] MarkdownContent is already overridden; render " +
              "src/integrations/mermaid/MarkdownContent.astro from that override instead.",
          );
        }
        updateConfig({
          components: {
            ...config.components,
            MarkdownContent: "./src/integrations/mermaid/MarkdownContent.astro",
          },
        });
        addIntegration({
          name: "pinchy-mermaid-markdown",
          hooks: {
            "astro:config:setup": ({ config: astroConfig }) => {
              registerMermaidTransform(astroConfig.markdown.processor);
            },
          },
        });
      },
    },
  };
}
