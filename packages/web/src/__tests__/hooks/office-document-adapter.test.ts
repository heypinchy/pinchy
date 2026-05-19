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
    extractRawText: vi.fn(async () => ({ value: "Hello extracted world", messages: [] })),
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

  it("extracts text with mammoth and returns a text content part", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    const file = fakeDocxFile({ size: 1024, name: "briefing.docx" });
    const pending = await adapter.add({ file });

    const result = await adapter.send(pending);

    expect(mammoth.extractRawText).toHaveBeenCalledOnce();
    expect(result.status).toEqual({ type: "complete" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "<attachment name=briefing.docx>\nHello extracted world\n</attachment>",
      },
    ]);
  });
});

describe("OfficeDocumentAttachmentAdapter.remove", () => {
  it("is a no-op (returns undefined)", async () => {
    const adapter = new OfficeDocumentAttachmentAdapter();
    await expect(adapter.remove()).resolves.toBeUndefined();
  });
});
