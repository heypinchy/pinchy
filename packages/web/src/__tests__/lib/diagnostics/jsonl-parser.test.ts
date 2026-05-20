import { describe, it, expect } from "vitest";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";

describe("parseJsonlLines", () => {
  it("parses well-formed JSONL into an array of events", () => {
    const input = '{"type":"text","text":"hi"}\n{"type":"done","finish_reason":"stop"}';
    expect(parseJsonlLines(input)).toEqual([
      { type: "text", text: "hi" },
      { type: "done", finish_reason: "stop" },
    ]);
  });

  it("ignores blank lines", () => {
    expect(parseJsonlLines('{"type":"a"}\n\n{"type":"b"}\n')).toEqual([
      { type: "a" },
      { type: "b" },
    ]);
  });

  it("skips malformed lines but preserves order of valid ones", () => {
    expect(parseJsonlLines('{"type":"ok"}\nNOT_JSON\n{"type":"also_ok"}')).toEqual([
      { type: "ok" },
      { type: "also_ok" },
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseJsonlLines('{"type":"a"}\r\n{"type":"b"}\r\n')).toEqual([
      { type: "a" },
      { type: "b" },
    ]);
  });

  it("drops a torn final line without affecting earlier valid events", () => {
    // OpenClaw writer crashed mid-flush — final line is an incomplete JSON object.
    // Earlier events must still be returned.
    const input = '{"type":"a"}\n{"type":"b"}\n{"type":"c","text":"hi';
    expect(parseJsonlLines(input)).toEqual([{ type: "a" }, { type: "b" }]);
  });
});
