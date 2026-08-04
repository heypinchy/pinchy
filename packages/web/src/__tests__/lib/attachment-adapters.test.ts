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
import type { PendingAttachment } from "@assistant-ui/react";
import { attachmentAdapter } from "@/lib/attachment-adapters";

function fakeFile({ name, type }: { name: string; type: string }): File {
  // Small size so any size check downstream passes.
  return { size: 1024, name, type } as unknown as File;
}

/**
 * `AttachmentAdapter.add()` is declared to return
 * `Promise<PendingAttachment> | AsyncGenerator<PendingAttachment, void>` (the
 * library supports streaming adapters), so `result` is still a union after
 * `await`ing it — `AsyncGenerator` has no `.type`. Every adapter Pinchy wires
 * into this composite (CodeTextAttachmentAdapter / OfficeDocumentAttachmentAdapter)
 * resolves a plain PendingAttachment, never a generator; this guard makes that
 * a real assertion instead of an unchecked cast.
 */
function expectPendingAttachment(
  value: PendingAttachment | AsyncGenerator<PendingAttachment, void, unknown>
): PendingAttachment {
  if (!("type" in value)) {
    throw new Error("expected a PendingAttachment, got an AsyncGenerator");
  }
  return value;
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
      const result = expectPendingAttachment(
        await attachmentAdapter.add({ file: fakeFile({ name, type }) })
      );
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

/**
 * Focused unit tests for OfficeDocumentAttachmentAdapter.
 *
 * The adapter accepts .docx files in the composer and extracts their text
 * with mammoth at upload time, the same way SimpleTextAttachmentAdapter
 * handles .txt. Without this adapter, dragging a .docx into the chat would
 * either be rejected by the composite adapter or — if accepted by the
 * SimpleTextAttachmentAdapter fallback — ship the ZIP archive's binary
 * bytes (starting with "PK") to the model, which is gibberish.
 */

import { vi } from "vitest";

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn(async () => ({
      value: "<h1>Hello extracted world</h1>",
      messages: [],
    })),
    images: {
      imgElement: vi.fn((fn) => fn),
    },
  },
}));

import { beforeEach } from "vitest";
import mammoth from "mammoth";
import { OfficeDocumentAttachmentAdapter } from "@/lib/attachment-adapters";
import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

function fakeDocxFile({ size, name = "briefing.docx" }: { size: number; name?: string }): File {
  return {
    size,
    name,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // The adapter reads file.arrayBuffer() in send(); jsdom's File doesn't
    // implement it on a stub, so we add a minimal stand-in.
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as File;
}

describe("OfficeDocumentAttachmentAdapter.accept", () => {
  it("includes the .docx MIME type and extension", () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    expect(adapter.accept).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(adapter.accept).toContain(".docx");
  });
});

describe("OfficeDocumentAttachmentAdapter.add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a file under the limit and returns a PendingAttachment", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024 });
    const result = await adapter.add({ file });
    expect(result.type).toBe("document");
    expect(result.status).toEqual({ type: "requires-action", reason: "composer-send" });
    expect(result.name).toBe("briefing.docx");
  });

  it("assigns a unique id to every add call, even when two files share a name", async () => {
    // Regression guard: a previous version used `file.name` as the id, which
    // collided when a user dropped two copies of the same filename into the
    // composer (e.g. one from Desktop and one from Downloads). The composite
    // adapter's downstream bookkeeping breaks when ids collide.
    const adapter = new OfficeDocumentAttachmentAdapter();
    const a = await adapter.add({ file: fakeDocxFile({ size: 1024, name: "report.docx" }) });
    const b = await adapter.add({ file: fakeDocxFile({ size: 1024, name: "report.docx" }) });
    expect(a.id).not.toBe(b.id);
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
  });

  it("rejects a file over the limit BEFORE encoding (size check happens in add)", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({
      size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES + 1,
      name: "huge.docx",
    });
    await expect(adapter.add({ file })).rejects.toThrow(/too large/i);
  });

  it("error message names the file", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({
      size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES + 1,
      name: "huge.docx",
    });
    await expect(adapter.add({ file })).rejects.toThrow(/huge\.docx/);
  });
});

describe("OfficeDocumentAttachmentAdapter.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts text with mammoth and returns a quoted-attribute text content part", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024, name: "briefing.docx" });
    const pending = await adapter.add({ file });

    const result = await adapter.send(pending);

    expect(mammoth.convertToHtml).toHaveBeenCalledOnce();
    expect(result.status).toEqual({ type: "complete" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: '<attachment name="briefing.docx">\n# Hello extracted world\n</attachment>',
      },
    ]);
  });

  it("escapes XML-special characters in the filename when wrapping content", async () => {
    // Filenames may legally contain spaces, ampersands, angle brackets,
    // and quotes. Without escaping, those leak into the wrapper tag and
    // either produce invalid XML or, worse, look like a different tag to
    // the model (e.g. `<attachment name=Q3 <draft>.docx>`).
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024, name: "Q3 & <draft>.docx" });
    const pending = await adapter.add({ file });

    const result = await adapter.send(pending);
    const text = (result.content[0] as { type: "text"; text: string }).text;

    expect(text.startsWith('<attachment name="Q3 &amp; &lt;draft&gt;.docx">')).toBe(true);
    expect(text.endsWith("</attachment>")).toBe(true);
    // Raw special characters must not survive in the wrapper attribute.
    expect(text).not.toContain("name=Q3");
    expect(text).not.toContain("<draft>");
  });

  it("converts table HTML to GFM pipe tables via turndown", async () => {
    // Override the default mock for this test only.
    (mammoth.convertToHtml as any).mockResolvedValueOnce({
      value: "<table><tr><td>SKU</td><td>Qty</td></tr><tr><td>WIDGET</td><td>20</td></tr></table>",
      messages: [],
    });
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024, name: "table.docx" });
    const pending = await adapter.add({ file });
    const result = await adapter.send(pending);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/\|\s*SKU\s*\|\s*Qty\s*\|/);
    expect(text).toMatch(/\|\s*WIDGET\s*\|\s*20\s*\|/);
  });

  it("replaces <img> elements with the [image] placeholder", async () => {
    (mammoth.convertToHtml as any).mockResolvedValueOnce({
      value: '<p>Before <img src="x" /> after</p>',
      messages: [],
    });
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024, name: "with-image.docx" });
    const pending = await adapter.add({ file });
    const result = await adapter.send(pending);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[image]");
    expect(text).not.toMatch(/<img/);
  });
});

describe("OfficeDocumentAttachmentAdapter.remove", () => {
  it("is a no-op (returns undefined)", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    await expect(adapter.remove()).resolves.toBeUndefined();
  });
});
