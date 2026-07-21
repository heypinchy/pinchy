import { describe, it, expect } from "vitest";
import { attachDeliveredFilesToHistory } from "@/server/delivery-marker";

type Msg = {
  role: "user" | "assistant";
  content: string;
  files?: Array<{ filename: string; mimeType: string }>;
  timestamp?: number;
};

describe("attachDeliveredFilesToHistory", () => {
  it("returns history unchanged when there are no grants", () => {
    const messages: Msg[] = [{ role: "assistant", content: "hi", timestamp: 100 }];
    expect(attachDeliveredFilesToHistory(messages, [])).toEqual(messages);
  });

  it("attaches a grant to the assistant turn active at delivery time (greatest ts <= createdAt)", () => {
    const messages: Msg[] = [
      { role: "user", content: "make a report", timestamp: 100 },
      { role: "assistant", content: "here you go", timestamp: 200 },
    ];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "report.pdf", mimeType: "application/pdf", createdAt: 250 },
    ]);
    expect(out[1].files).toEqual([{ filename: "report.pdf", mimeType: "application/pdf" }]);
    // The user turn is untouched.
    expect(out[0].files).toBeUndefined();
  });

  it("routes each grant to its own turn in a multi-delivery conversation", () => {
    const messages: Msg[] = [
      { role: "assistant", content: "first", timestamp: 100 },
      { role: "assistant", content: "second", timestamp: 300 },
    ];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "a.pdf", mimeType: "application/pdf", createdAt: 150 },
      { filename: "b.pdf", mimeType: "application/pdf", createdAt: 350 },
    ]);
    expect(out[0].files).toEqual([{ filename: "a.pdf", mimeType: "application/pdf" }]);
    expect(out[1].files).toEqual([{ filename: "b.pdf", mimeType: "application/pdf" }]);
  });

  it("merges multiple grants delivered within one turn", () => {
    const messages: Msg[] = [{ role: "assistant", content: "bundle", timestamp: 100 }];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "a.csv", mimeType: "text/csv", createdAt: 120 },
      { filename: "b.csv", mimeType: "text/csv", createdAt: 130 },
    ]);
    expect(out[0].files?.map((f) => f.filename)).toEqual(["a.csv", "b.csv"]);
  });

  it("falls back to the first assistant turn when a grant predates every turn", () => {
    const messages: Msg[] = [{ role: "assistant", content: "only", timestamp: 500 }];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "x.pdf", mimeType: "application/pdf", createdAt: 100 },
    ]);
    expect(out[0].files).toEqual([{ filename: "x.pdf", mimeType: "application/pdf" }]);
  });

  it("never attaches a delivered file to a user turn", () => {
    const messages: Msg[] = [{ role: "user", content: "hi", timestamp: 100 }];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "x.pdf", mimeType: "application/pdf", createdAt: 200 },
    ]);
    expect(out[0].files).toBeUndefined();
  });

  it("preserves files already present on a turn (does not clobber user attachments)", () => {
    const messages: Msg[] = [
      {
        role: "user",
        content: "see attached",
        files: [{ filename: "in.pdf", mimeType: "application/pdf" }],
        timestamp: 100,
      },
      { role: "assistant", content: "thanks", timestamp: 200 },
    ];
    const out = attachDeliveredFilesToHistory(messages, [
      { filename: "out.pdf", mimeType: "application/pdf", createdAt: 250 },
    ]);
    expect(out[0].files).toEqual([{ filename: "in.pdf", mimeType: "application/pdf" }]);
    expect(out[1].files).toEqual([{ filename: "out.pdf", mimeType: "application/pdf" }]);
  });
});
