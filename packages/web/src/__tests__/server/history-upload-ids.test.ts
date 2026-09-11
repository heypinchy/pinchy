import { describe, it, expect } from "vitest";
import {
  collectAttachmentFilenames,
  indexUploadIdsByFilename,
  attachUploadIdsToHistory,
  type HistoryFileMeta,
} from "@/server/history-upload-ids";

describe("collectAttachmentFilenames", () => {
  it("returns each distinct filename a user turn carries a chip for", () => {
    const names = collectAttachmentFilenames([
      { role: "user", files: [{ filename: "a.pdf", mimeType: "application/pdf" }] },
      { role: "assistant" },
      {
        role: "user",
        files: [
          { filename: "b.png", mimeType: "image/png" },
          { filename: "a.pdf", mimeType: "application/pdf" },
        ],
      },
    ]);
    expect(names.sort()).toEqual(["a.pdf", "b.png"]);
  });

  it("ignores assistant turns", () => {
    // Assistant chips come from agent_delivered_files and have no upload row.
    // Querying for them cannot match — and if an upload of the same name did
    // exist, stamping its id onto an assistant turn would put a retryable id
    // on a turn that can never be retried.
    expect(
      collectAttachmentFilenames([
        { role: "assistant", files: [{ filename: "report.xlsx", mimeType: "application/xlsx" }] },
      ])
    ).toEqual([]);
  });

  it("returns nothing when no turn has files", () => {
    expect(collectAttachmentFilenames([{ role: "user" }, { role: "assistant" }])).toEqual([]);
  });
});

describe("indexUploadIdsByFilename", () => {
  it("maps each filename to its upload id", () => {
    const index = indexUploadIdsByFilename([
      { id: "id-a", filename: "a.pdf" },
      { id: "id-b", filename: "b.png" },
    ]);
    expect(index.get("a.pdf")).toBe("id-a");
    expect(index.get("b.png")).toBe("id-b");
  });

  it("drops a filename two rows claim rather than picking one", () => {
    // Guessing here would re-send a DIFFERENT file under the right name on the
    // next retry — a silent wrong answer. No id degrades to re-sending the text
    // alone, which is merely the old behaviour.
    const index = indexUploadIdsByFilename([
      { id: "id-1", filename: "invoice.pdf" },
      { id: "id-2", filename: "invoice.pdf" },
      { id: "id-3", filename: "other.pdf" },
    ]);
    expect(index.has("invoice.pdf")).toBe(false);
    expect(index.get("other.pdf")).toBe("id-3");
  });
});

describe("attachUploadIdsToHistory", () => {
  it("stamps the id onto a user turn's chips", () => {
    const messages = [
      {
        role: "user" as const,
        files: [{ filename: "a.pdf", mimeType: "application/pdf" }] as HistoryFileMeta[],
      },
    ];
    const out = attachUploadIdsToHistory(messages, new Map([["a.pdf", "id-a"]]));
    expect(out[0].files?.[0].uploadId).toBe("id-a");
  });

  it("leaves an unresolvable chip without an id", () => {
    const messages = [
      {
        role: "user" as const,
        files: [
          { filename: "a.pdf", mimeType: "application/pdf" },
          { filename: "gone.pdf", mimeType: "application/pdf" },
        ] as HistoryFileMeta[],
      },
    ];
    const out = attachUploadIdsToHistory(messages, new Map([["a.pdf", "id-a"]]));
    expect(out[0].files?.[0].uploadId).toBe("id-a");
    expect(out[0].files?.[1].uploadId).toBeUndefined();
  });

  it("never stamps an assistant turn", () => {
    const messages = [
      {
        role: "assistant" as const,
        files: [{ filename: "a.pdf", mimeType: "application/pdf" }] as HistoryFileMeta[],
      },
    ];
    const out = attachUploadIdsToHistory(messages, new Map([["a.pdf", "id-a"]]));
    expect(out[0].files?.[0].uploadId).toBeUndefined();
  });

  it("returns the same references for turns it does not touch", () => {
    // Same contract as attachDeliveredFilesToHistory, which runs right after
    // this one: the history-reconcile path on the client compares message
    // identity, so gratuitous cloning is not free.
    const untouched = { role: "assistant" as const };
    const messages = [
      untouched,
      { role: "user" as const, files: [{ filename: "a.pdf", mimeType: "application/pdf" }] },
    ];
    const out = attachUploadIdsToHistory(messages, new Map([["a.pdf", "id-a"]]));
    expect(out[0]).toBe(untouched);
    expect(out[1]).not.toBe(messages[1]);
  });

  it("returns the input array when nothing resolved", () => {
    const messages = [
      { role: "user" as const, files: [{ filename: "a.pdf", mimeType: "application/pdf" }] },
    ];
    expect(attachUploadIdsToHistory(messages, new Map())).toBe(messages);
  });
});
