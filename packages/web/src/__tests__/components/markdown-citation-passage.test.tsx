// @vitest-environment jsdom
/**
 * The cited claim travelling from an answer's text to the citation viewer
 * (#1268), through the REAL markdown pipeline: remark derives the claim, hast
 * carries it as a property, react-markdown hands it to the `a` override, and
 * the override turns it into the viewer's passage lookup.
 *
 * The viewer is replaced by a recorder, for the reason markdown-citation-
 * render.test.tsx gives: driving a Radix dialog through a portal in jsdom does
 * not settle reliably. What is behind the click is pdf-dialog.test.tsx's job.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import type { ReactNode } from "react";

const dialogProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/assistant-ui/attachment-preview", () => ({
  PdfDialog: (props: Record<string, unknown> & { children: ReactNode }) => {
    dialogProps.push(props);
    return <>{props.children}</>;
  },
}));

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { AgentIdContext } from "@/components/chat";

function renderAnswer(text: string) {
  dialogProps.length = 0;
  render(
    <AgentIdContext.Provider value="agent-1">
      <TextMessagePartProvider text={text} isRunning={false}>
        <MarkdownText smooth={false} />
      </TextMessagePartProvider>
    </AgentIdContext.Provider>
  );
  return dialogProps.at(-1) as { passage: unknown; page: unknown };
}

describe("the claim a citation supports reaches the viewer", () => {
  it("asks for the passage behind a Sources entry with the sentences that cite it", () => {
    const props = renderAnswer(
      [
        "Der Auftragnehmer reagiert binnen vier Stunden [1].",
        "",
        "**Quellen:**",
        "",
        "- [1] quality/Wartung.pdf — p. 4",
      ].join("\n")
    );

    expect(props.page).toBe(4);
    expect(props.passage).toEqual({
      url: "/api/agents/agent-1/knowledge/passage",
      body: {
        path: "/data/quality/Wartung.pdf",
        page: 4,
        claim: "Der Auftragnehmer reagiert binnen vier Stunden.",
      },
    });
  });

  it("asks for nothing when the citation has no page", () => {
    const props = renderAnswer("See quality/Wartung.pdf for details on response times.");
    expect(props.passage).toBeNull();
  });

  it("does not put the claim on the link a reader sees", () => {
    renderAnswer(["Vier Stunden [1].", "", "- [1] quality/Wartung.pdf — p. 4"].join("\n"));
    expect(document.querySelector("[data-cited-claim]")).toBeNull();
  });
});
