/**
 * Focused unit tests for SimpleBinaryFileAttachmentAdapter.
 *
 * The adapter is also exercised end-to-end by the use-ws-runtime suites,
 * but those tests fake the FileMessagePart content directly. These tests
 * cover the contract observed by assistant-ui: size validation happens in
 * add() so picking a too-big file fails instantly without encoding it.
 */

// jsdom does not implement FileReader.readAsDataURL on real File buffers, so
// stub fileToDataUrl. The send() test asserts only the *shape* of the result.
import { vi } from "vitest";
vi.mock("@/lib/data-url", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-url")>("@/lib/data-url");
  return {
    ...actual,
    fileToDataUrl: vi.fn(async () => "data:application/pdf;base64,YWJj"),
  };
});

import { describe, it, expect } from "vitest";
import { SimpleBinaryFileAttachmentAdapter } from "@/hooks/use-ws-runtime";
import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

function fakeFile({ size, name = "test.pdf" }: { size: number; name?: string }): File {
  return { size, name, type: "application/pdf" } as unknown as File;
}

describe("SimpleBinaryFileAttachmentAdapter.add", () => {
  it("accepts a file under the limit and returns a PendingAttachment", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    const file = fakeFile({ size: 1024 });
    const result = await adapter.add({ file });
    expect(result.type).toBe("file");
    expect(result.status).toEqual({ type: "requires-action", reason: "composer-send" });
    expect(result.file).toBe(file);
    expect(result.name).toBe("test.pdf");
  });

  it("rejects a file over the limit BEFORE encoding (size check happens in add, not send)", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    const file = fakeFile({ size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES + 1, name: "huge.pdf" });
    await expect(adapter.add({ file })).rejects.toThrow(/too large/i);
  });

  it("error message names the file and surfaces the MB limit", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    const file = fakeFile({ size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES + 1, name: "huge.pdf" });
    const limitMb = Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024);
    await expect(adapter.add({ file })).rejects.toThrow(new RegExp(`huge\\.pdf.*${limitMb}`));
  });

  it("accepts a file exactly at the limit (boundary)", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    const file = fakeFile({ size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES });
    await expect(adapter.add({ file })).resolves.toBeDefined();
  });
});

describe("SimpleBinaryFileAttachmentAdapter.send", () => {
  it("returns a CompleteAttachment with a FileMessagePart carrying base64 data + mimeType", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    const file = fakeFile({ size: 1024, name: "doc.pdf" });
    const sent = await adapter.send({ id: "att-1", name: "doc.pdf", file });
    expect(sent.id).toBe("att-1");
    expect(sent.type).toBe("file");
    expect(sent.status).toEqual({ type: "complete" });
    expect(sent.content).toEqual([
      {
        type: "file",
        data: "YWJj",
        mimeType: "application/pdf",
        filename: "doc.pdf",
      },
    ]);
  });

  // Originally `send()` parsed the data URL with raw `indexOf(",")` and
  // `indexOf(";")` and silently produced garbage `mimeType` if the URL
  // wasn't in the expected `data:<mime>;base64,<data>` shape. A future
  // `fileToDataUrl` implementation that returned `;` before `:` (or the
  // URL being mangled in transit) would have shipped a corrupt mime/base64
  // pair to the server. Better to fail closed at the parse step so the
  // composer surfaces the error instead of the server choking on it.
  it("rejects when the data URL is not a well-formed base64 data: URL", async () => {
    const dataUrlModule = await import("@/lib/data-url");
    vi.mocked(dataUrlModule.fileToDataUrl).mockResolvedValueOnce("not-a-data-url");
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    await expect(adapter.send({ name: "doc.pdf", file: fakeFile({ size: 1 }) })).rejects.toThrow(
      /data url|invalid/i
    );
  });

  it("rejects when the data URL is not base64-encoded (e.g. URL-encoded text)", async () => {
    const dataUrlModule = await import("@/lib/data-url");
    vi.mocked(dataUrlModule.fileToDataUrl).mockResolvedValueOnce("data:text/plain,hello");
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    await expect(adapter.send({ name: "doc.pdf", file: fakeFile({ size: 1 }) })).rejects.toThrow(
      /data url|invalid|base64/i
    );
  });

  it("rejects when the mime type is empty", async () => {
    const dataUrlModule = await import("@/lib/data-url");
    vi.mocked(dataUrlModule.fileToDataUrl).mockResolvedValueOnce("data:;base64,YWJj");
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    await expect(adapter.send({ name: "doc.pdf", file: fakeFile({ size: 1 }) })).rejects.toThrow(
      /data url|invalid|mime/i
    );
  });
});

describe("SimpleBinaryFileAttachmentAdapter.remove", () => {
  it("is a no-op (returns undefined)", async () => {
    const adapter = new SimpleBinaryFileAttachmentAdapter();
    await expect(adapter.remove({ id: "anything" })).resolves.toBeUndefined();
  });
});
