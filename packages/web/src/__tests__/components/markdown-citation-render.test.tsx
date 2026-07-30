/**
 * Renders a knowledge-base answer through the REAL markdown pipeline and
 * checks that a cited source ends up clickable.
 *
 * The other two tests around this feature each stop one step short, on purpose,
 * and the gap between them is exactly where this feature has failed before:
 *
 *   - `source-links.test.ts` hands the transformer an mdast tree built BY HAND
 *     (`root > paragraph > text`). It proves the transform is right about a
 *     tree — not that remark produces that tree. A real Sources list is a
 *     markdown LIST, so the text arrives at `list > listItem > paragraph >
 *     text`, and `[2]` is a shape markdown could have claimed for itself as a
 *     link reference.
 *   - `markdown-remark-plugins.test.ts` reimplements unified's attach step to
 *     catch an attacher/transformer mixup. A reimplementation cannot be wrong
 *     in the same way the real thing is.
 *
 * So this one uses `TextMessagePartProvider` to feed the real `MarkdownText`
 * the way a streamed message does: real remark, real remark-gfm, real
 * react-markdown, the real component overrides — including the `a` override
 * that turns a citation into the lightbox trigger. If any link in that chain
 * stops holding, no unit test above would notice, and the failure mode is a
 * whole answer rendering as plain text.
 *
 * It deliberately stops at the trigger and does not click it. Opening the
 * lightbox for real means driving a Radix dialog through a portal in jsdom,
 * which does not settle reliably here — `pdf-dialog.test.tsx` covers what is
 * behind the click by rendering the dialog open (which is what its
 * `defaultOpen` escape hatch exists for). A test that is occasionally right is
 * worse than a boundary drawn on purpose.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TextMessagePartProvider } from "@assistant-ui/react";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { AgentIdContext } from "@/components/chat";

/**
 * The template's Sources shape, verbatim: a markdown list, a bracketed index,
 * an em dash, a position. Every element here is one markdown could parse into
 * something other than a plain text node.
 *
 * The paths are data-root-relative, because that is what `knowledge_search`
 * shows the model and a model can only cite what it is shown (#933). Which also
 * makes this the one test that would catch the whole feature going dark on that
 * change: with no leading `/` to key off, a linkifier still looking for an
 * absolute path matches nothing and every answer renders as flat text.
 */
const ANSWER = [
  "Die Nachweisgrenze liegt bei 0,05 mg/kg.",
  "",
  "**Quellen:**",
  "",
  "- [1] noack/PPR/document.pdf — p. 510",
  "- [2] noack/PF LAB/afnor_update_&_support.pdf — p. 44",
].join("\n");

function renderAnswer(agentId: string | null, text = ANSWER) {
  return render(
    <AgentIdContext.Provider value={agentId}>
      <TextMessagePartProvider text={text} isRunning={false}>
        {/*
          Smoothing off. It animates the text in over requestAnimationFrame, so
          with it on these assertions wait on an animation clock rather than on
          the pipeline they are about — which is a flake on a loaded runner, not
          a signal. Off, the whole answer is present from the first render.
         */}
        <MarkdownText smooth={false} />
      </TextMessagePartProvider>
    </AgentIdContext.Provider>
  );
}

describe("a cited source rendered through the real markdown pipeline", () => {
  it("comes out clickable, once per source, with the page kept in the visible text", async () => {
    renderAnswer("agent-1");

    // Queried by text rather than by role+name: an accessible-name lookup
    // rescans the whole tree on every retry, which is slow enough under load to
    // exhaust the timeout before the assertion ever runs. The tag check below
    // keeps the guarantee that matters.
    const first = await screen.findByText("noack/PPR/document.pdf");
    const second = await screen.findByText("noack/PF LAB/afnor_update_&_support.pdf");

    // A citation opens the lightbox rather than navigating away from the answer
    // it belongs to, so the trigger is a button and not an anchor.
    expect(first.tagName).toBe("BUTTON");
    expect(second.tagName).toBe("BUTTON");

    // The page stays readable in the answer; only the link opens at it.
    expect(screen.getByText(/p\. 510/)).toBeInTheDocument();
  });

  it("leaves the answer as plain text when there is no agent to scope a link to", async () => {
    renderAnswer(null);

    expect(await screen.findByText(/Nachweisgrenze/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("makes an Office source clickable too, now that it has a preview to open", async () => {
    // Nothing indexes Office documents yet (#938 wires that), so this is the
    // renderer half of the chain arriving first — and the half that would fail
    // silently: an unlinkified citation is not an error, it is flat text
    // nobody notices until someone asks why the .doc is not clickable.
    renderAnswer("agent-1", "- [1] noack/QF_2012/Angebot.doc — S. 3");

    expect((await screen.findByText("noack/QF_2012/Angebot.doc")).tagName).toBe("BUTTON");
  });

  it("does not touch a path shown as code", async () => {
    // Inside backticks a path is being displayed, not referenced. remark gives
    // it its own node type, and the plugin has to respect that in the real tree
    // and not only in a hand-built one.
    renderAnswer("agent-1", "Der Pfad `noack/PPR/document.pdf` liegt im Korpus.");

    expect(await screen.findByText("noack/PPR/document.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
