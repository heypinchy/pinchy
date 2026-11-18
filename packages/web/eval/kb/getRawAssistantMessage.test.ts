// packages/web/eval/kb/getRawAssistantMessage.test.ts
//
// Unit test of the pure extractor (`extractRawAssistantText`) against a
// realistic fixture shaped like a real diagnostics-export response body
// (`Bundle` in src/lib/diagnostics/bundle-builder.ts, built by
// buildOtelSpans in src/lib/diagnostics/otel-builder.ts). The impure
// `getRawAssistantMessage(page, agentId, chatId)` (two live HTTP calls) is
// NOT covered here — it needs a real Playwright `page` against a running
// stack; see its own doc comment for the "NEEDS VALIDATION AGAINST THE
// RUNNING STACK" note.
import { describe, expect, it } from "vitest";

import { extractRawAssistantText } from "./getRawAssistantMessage";
import type { DiagnosticsBundleFixture } from "./getRawAssistantMessage";

/** One realistic span, shaped exactly like buildOtelSpans's real output for one turn. */
function assistantSpan(text: string): DiagnosticsBundleFixture["spans"][number] {
  return {
    attributes: {
      "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: text }] }],
    },
  };
}

describe("extractRawAssistantText", () => {
  it("extracts the raw markdown text of a single-turn bundle, bullets intact", () => {
    const bundle: DiagnosticsBundleFixture = {
      spans: [
        assistantSpan(
          "Northwind replaces laptops every 3 years [1].\n\n" +
            "**Sources:**\n\n" +
            "- [1] /data/it-equipment-policy.md (p. 1)"
        ),
      ],
    };

    const text = extractRawAssistantText(bundle);

    expect(text).toContain("- [1] /data/it-equipment-policy.md");
    expect(text).toBe(
      "Northwind replaces laptops every 3 years [1].\n\n" +
        "**Sources:**\n\n" +
        "- [1] /data/it-equipment-policy.md (p. 1)"
    );
  });

  it("returns the LAST assistant turn across multiple spans, not the first", () => {
    const bundle: DiagnosticsBundleFixture = {
      spans: [assistantSpan("first turn answer"), assistantSpan("second turn answer")],
    };

    expect(extractRawAssistantText(bundle)).toBe("second turn answer");
  });

  it("skips a user-role message and finds the assistant message within the same span", () => {
    const bundle: DiagnosticsBundleFixture = {
      spans: [
        {
          attributes: {
            "gen_ai.output.messages": [
              { role: "user", parts: [{ type: "text", content: "should never be returned" }] },
              { role: "assistant", parts: [{ type: "text", content: "the real answer" }] },
            ],
          },
        },
      ],
    };

    expect(extractRawAssistantText(bundle)).toBe("the real answer");
  });

  it("returns null (not a throw) when no span carries gen_ai.output.messages", () => {
    const bundle: DiagnosticsBundleFixture = { spans: [{ attributes: {} }] };
    expect(extractRawAssistantText(bundle)).toBeNull();
  });

  it("returns null for an empty spans array (trajectory-missing / empty chat)", () => {
    expect(extractRawAssistantText({ spans: [] })).toBeNull();
  });

  it("skips a span whose assistant message has no text part (e.g. tool-call-only turn) and keeps looking", () => {
    const bundle: DiagnosticsBundleFixture = {
      spans: [
        assistantSpan("earlier real answer"),
        {
          attributes: {
            "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "tool_call" }] }],
          },
        },
      ],
    };

    // The later span has no usable text part, so the extractor falls back to
    // the earlier span's real answer rather than returning null.
    expect(extractRawAssistantText(bundle)).toBe("earlier real answer");
  });
});
