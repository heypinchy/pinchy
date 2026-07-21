import { describe, it, expect } from "vitest";
import { attachDeliveredFile } from "@/hooks/attach-delivered-file";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  files?: Array<{ filename: string; mimeType: string }>;
  error?: unknown;
};

const file = { filename: "report.pdf", mimeType: "application/pdf" };

describe("attachDeliveredFile", () => {
  it("attaches to the assistant message carrying the frame's id", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "make a report" },
      { id: "a1", role: "assistant", content: "here you go" },
    ];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out[1].files).toEqual([file]);
    expect(out[0].files).toBeUndefined();
  });

  it("merges into an assistant message that is not last (resume path)", () => {
    const messages: Msg[] = [
      { id: "a1", role: "assistant", content: "streaming" },
      { id: "u2", role: "user", content: "later turn" },
    ];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out[0].files).toEqual([file]);
  });

  it("adopts a trailing empty assistant placeholder (file arrives before first text chunk)", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "make it" },
      { id: "local-tmp", role: "assistant", content: "" },
    ];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe("a1");
    expect(out[1].files).toEqual([file]);
  });

  it("appends a new assistant message when no target exists", () => {
    const messages: Msg[] = [{ id: "u1", role: "user", content: "hi" }];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ id: "a1", role: "assistant", content: "", files: [file] });
  });

  it("preserves existing files and appends the new one", () => {
    const messages: Msg[] = [
      {
        id: "a1",
        role: "assistant",
        content: "two files",
        files: [{ filename: "a.csv", mimeType: "text/csv" }],
      },
    ];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out[0].files?.map((f) => f.filename)).toEqual(["a.csv", "report.pdf"]);
  });

  it("does not duplicate the same file on a repeated frame", () => {
    const messages: Msg[] = [{ id: "a1", role: "assistant", content: "x", files: [file] }];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out[0].files).toEqual([file]);
  });

  it("never adopts an error placeholder", () => {
    const messages: Msg[] = [
      { id: "err", role: "assistant", content: "", error: { message: "boom" } },
    ];
    const out = attachDeliveredFile(messages, { id: "a1", ...file });
    expect(out).toHaveLength(2);
    expect(out[0].files).toBeUndefined();
    expect(out[1].id).toBe("a1");
  });
});
