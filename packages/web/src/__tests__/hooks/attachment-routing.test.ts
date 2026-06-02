/**
 * Routing tests for the CompositeAttachmentAdapter wired up in use-ws-runtime.
 *
 * The composite picks the FIRST adapter whose `accept` matches a file. The
 * order is [image, code-text, office, binary], so a type also claimed by the
 * code-text adapter would be captured inline as text rather than uploaded to
 * the workspace.
 *
 * Issue #392: CSV / plain-text / Markdown / JSON / YAML files must be routed
 * to the workspace upload path (SimpleBinaryFileAttachmentAdapter, which
 * returns `type: "file"`), NOT inlined by the code-text adapter (which returns
 * `type: "document"`). Code files (.ts, .py, …) must still inline as text.
 *
 * We exercise the REAL assistant-ui composite (no @assistant-ui mock here) by
 * calling attachmentAdapter.add() and inspecting which adapter handled it.
 */

import { describe, it, expect } from "vitest";
import { attachmentAdapter } from "@/hooks/use-ws-runtime";

function fakeFile({ name, type }: { name: string; type: string }): File {
  // Small size so the binary adapter's size check passes.
  return { size: 1024, name, type } as unknown as File;
}

const WORKSPACE_CASES = [
  { name: "data.csv", type: "text/csv" },
  { name: "notes.txt", type: "text/plain" },
  { name: "README.md", type: "text/markdown" },
  { name: "config.json", type: "application/json" },
  { name: "config.yaml", type: "text/yaml" },
  { name: "config.yml", type: "text/yaml" },
];

const INLINE_CODE_CASES = [
  { name: "script.ts", type: "application/typescript" },
  { name: "script.py", type: "" },
  { name: "main.go", type: "" },
  { name: "styles.css", type: "text/css" },
];

describe("attachment routing (issue #392)", () => {
  it.each(WORKSPACE_CASES)(
    "routes $name ($type) to the workspace binary adapter (type 'file')",
    async ({ name, type }) => {
      const result = await attachmentAdapter.add({ file: fakeFile({ name, type }) });
      expect(result.type).toBe("file");
    }
  );

  it.each(INLINE_CODE_CASES)(
    "keeps $name ($type) on the inline code-text adapter (type 'document')",
    async ({ name, type }) => {
      const result = await attachmentAdapter.add({ file: fakeFile({ name, type }) });
      expect(result.type).toBe("document");
    }
  );

  it("still routes PDFs to the workspace binary adapter (type 'file')", async () => {
    const result = await attachmentAdapter.add({
      file: fakeFile({ name: "report.pdf", type: "application/pdf" }),
    });
    expect(result.type).toBe("file");
  });
});
