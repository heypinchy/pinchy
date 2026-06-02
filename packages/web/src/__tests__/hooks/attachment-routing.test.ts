/**
 * Routing tests for the CompositeAttachmentAdapter wired up in use-ws-runtime.
 *
 * The composite picks the FIRST adapter whose `accept` matches a file. As of
 * PR #342 (two-phase upload pipeline), the adapter chain ONLY handles inline-
 * text routes (code-text + office .docx). Workspace binaries (PDF, image, CSV,
 * plain text, Markdown, JSON, YAML) bypass the adapter chain entirely — they
 * flow through `PinchyAttachmentButton` / `PinchyDropZone` →
 * `addPendingUpload` → POST `/api/agents/<id>/uploads`. The composite MUST
 * reject those types so a future regression that re-adds a binary adapter to
 * the composite would fail this test instead of silently dual-routing files.
 *
 * Issue #392 (preserved invariant): CSV / plain-text / Markdown / JSON / YAML
 * files must NOT be inlined as text by the code-text adapter. The expression
 * is now "composite rejects them" rather than "binary adapter accepts them"
 * — same invariant, different architecture.
 *
 * Code files (.ts, .py, .go, .css) must still inline as text.
 */

import { describe, it, expect } from "vitest";
import { attachmentAdapter } from "@/hooks/use-ws-runtime";

function fakeFile({ name, type }: { name: string; type: string }): File {
  // Small size so any size check downstream passes.
  return { size: 1024, name, type } as unknown as File;
}

const UPLOAD_PIPELINE_CASES = [
  { name: "data.csv", type: "text/csv" },
  { name: "notes.txt", type: "text/plain" },
  { name: "README.md", type: "text/markdown" },
  { name: "config.json", type: "application/json" },
  { name: "config.yaml", type: "text/yaml" },
  { name: "config.yml", type: "text/yaml" },
  // Browsers commonly leave File.type empty for these, so the extension is the
  // only routing signal — the composite must reject them by extension too,
  // otherwise an empty-type file slips into the code-text adapter and gets
  // inlined as text.
  { name: "notes.markdown", type: "" },
  { name: "untyped.csv", type: "" },
  { name: "untyped.yaml", type: "" },
];

const INLINE_CODE_CASES = [
  { name: "script.ts", type: "application/typescript" },
  { name: "script.py", type: "" },
  { name: "main.go", type: "" },
  { name: "styles.css", type: "text/css" },
];

describe("attachment routing (issue #392)", () => {
  // `CompositeAttachmentAdapter.add` throws SYNCHRONOUSLY when no adapter
  // matches (`return adapter.add(state)` returns a Promise, but the fall-through
  // `throw new Error(...)` runs in the synchronous prelude). So we wrap with a
  // thunk and use the sync `.toThrow()` matcher — an async `.rejects.toThrow()`
  // would never see the rejection because the throw escapes before any Promise
  // is ever constructed.
  it.each(UPLOAD_PIPELINE_CASES)(
    "composite rejects $name ($type) so it routes through addPendingUpload, not the adapter chain",
    ({ name, type }) => {
      expect(() => attachmentAdapter.add({ file: fakeFile({ name, type }) })).toThrow(
        /No matching adapter/
      );
    }
  );

  it.each(INLINE_CODE_CASES)(
    "keeps $name ($type) on the inline code-text adapter (type 'document')",
    async ({ name, type }) => {
      const result = await attachmentAdapter.add({ file: fakeFile({ name, type }) });
      expect(result.type).toBe("document");
    }
  );

  it("composite rejects PDFs so they route through addPendingUpload", () => {
    expect(() =>
      attachmentAdapter.add({
        file: fakeFile({ name: "report.pdf", type: "application/pdf" }),
      })
    ).toThrow(/No matching adapter/);
  });
});
