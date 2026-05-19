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

import { describe, it, expect, beforeEach } from "vitest";
import mammoth from "mammoth";
import { OfficeDocumentAttachmentAdapter } from "@/hooks/use-ws-runtime";
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
