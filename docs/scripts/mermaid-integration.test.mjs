import { test } from "node:test";
import assert from "node:assert/strict";
import starlightMermaid, {
  mermaidMdastPlugin,
  registerMermaidTransform,
} from "../src/integrations/mermaid/index.mjs";

// The integration lives in src/integrations/mermaid/; its tests live here so
// the pinned `node --test scripts/*.test.mjs` glob runs them (see
// scripts/lib/docs-link-gate.mjs at the repo root).

const satteriLike = () => ({
  name: "satteri",
  options: { mdastPlugins: [], hastPlugins: [], features: {} },
});

test("a ```mermaid code node becomes an empty diagram container", () => {
  const node = mermaidMdastPlugin.code({
    type: "code",
    lang: "mermaid",
    value: 'graph TD\n  A["<b>"] --> B',
  });
  assert.deepEqual(node, {
    type: "paragraph",
    data: {
      hName: "div",
      hProperties: {
        class: "mermaid",
        "data-content": 'graph TD\n  A["<b>"] --> B',
        "data-status": "loading",
      },
    },
    children: [],
  });
});

test("other code nodes are left to the code renderer", () => {
  assert.equal(
    mermaidMdastPlugin.code({ type: "code", lang: "bash", value: "echo" }),
    undefined,
  );
  assert.equal(
    mermaidMdastPlugin.code({ type: "code", lang: null, value: "x" }),
    undefined,
  );
});

test("registers on a Sätteri processor", () => {
  const processor = satteriLike();
  registerMermaidTransform(processor);
  assert.deepEqual(processor.options.mdastPlugins, [mermaidMdastPlugin]);
});

test("refuses any other processor instead of silently skipping it", () => {
  // A silent skip is the failure this integration replaces: under astro 7 the
  // old plugin's remark transform simply never ran, and the diagram shipped as
  // a code block with every check green.
  for (const processor of [{ name: "unified", options: {} }, undefined]) {
    assert.throws(
      () => registerMermaidTransform(processor),
      /cannot register on markdown\.processor/,
    );
  }
});

function setup(components = {}) {
  const calls = { starlight: [], integrations: [] };
  starlightMermaid().hooks["config:setup"]({
    config: { components },
    updateConfig: (c) => calls.starlight.push(c),
    addIntegration: (i) => calls.integrations.push(i),
  });
  return calls;
}

test("overrides MarkdownContent and registers the transform at config:setup", () => {
  const calls = setup({ Header: "./src/Header.astro" });
  assert.deepEqual(calls.starlight, [
    {
      components: {
        Header: "./src/Header.astro",
        MarkdownContent: "./src/integrations/mermaid/MarkdownContent.astro",
      },
    },
  ]);

  const [integration] = calls.integrations;
  const processor = satteriLike();
  const astroUpdates = [];
  integration.hooks["astro:config:setup"]({
    config: { markdown: { processor } },
    updateConfig: (c) => astroUpdates.push(c),
  });
  assert.deepEqual(processor.options.mdastPlugins, [mermaidMdastPlugin]);
  // In dev, mermaid is reached only through a dynamic import; without the
  // pre-bundle hint Vite discovers it mid-session (reload) and its CJS
  // dependencies trip ESM interop. The plugin this replaces set the same hint.
  assert.deepEqual(astroUpdates, [
    { vite: { optimizeDeps: { include: ["mermaid"] } } },
  ]);
});

test("refuses to clobber an existing MarkdownContent override", () => {
  assert.throws(
    () => setup({ MarkdownContent: "./src/Mine.astro" }),
    /MarkdownContent is already overridden/,
  );
});
