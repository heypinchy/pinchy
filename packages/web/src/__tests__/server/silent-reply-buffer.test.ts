import { describe, it, expect } from "vitest";
import {
  SILENT_REPLY_TOKEN,
  safeEmitLength,
  stripFinalEnvelope,
  stripControlTokens,
} from "@/server/silent-reply-buffer";

describe("SILENT_REPLY_TOKEN", () => {
  it("matches OpenClaw's silent-reply sentinel", () => {
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
  });
});

describe("safeEmitLength", () => {
  it("returns full length when no suffix could become the sentinel", () => {
    expect(safeEmitLength("Hello world")).toBe(11);
  });

  it("returns 0 when the entire buffer is the sentinel", () => {
    expect(safeEmitLength("NO_REPLY")).toBe(0);
  });

  it("holds back any sentinel-prefix suffix", () => {
    expect(safeEmitLength("Hello NO_RE")).toBe(6);
    expect(safeEmitLength("Hello N")).toBe(6);
    expect(safeEmitLength("foo NO")).toBe(4);
  });

  it("holds back single sentinel-prefix characters", () => {
    expect(safeEmitLength("N")).toBe(0);
  });

  it("does not hold back lowercase or unrelated characters", () => {
    // 'n' is not a prefix character of 'NO_REPLY'.
    expect(safeEmitLength("done.")).toBe(5);
    expect(safeEmitLength("now")).toBe(3);
  });

  it("returns 0 for an empty buffer", () => {
    expect(safeEmitLength("")).toBe(0);
  });

  it("handles a buffer that is longer than the sentinel and ends mid-sentinel", () => {
    // The trailing "NO_R" could still grow into the sentinel.
    expect(safeEmitLength("done. then NO_R")).toBe(11);
  });

  it("does not hold back when sentinel-like characters do not align as a suffix", () => {
    // 'Hello NOON' contains 'NO' but ends with 'N' which IS a sentinel
    // prefix — the longest matching suffix is 'N' (1 char).
    expect(safeEmitLength("Hello NOON")).toBe(9);
  });

  it("holds back any <final>-prefix suffix so split opening tags get stripped", () => {
    expect(safeEmitLength("Hello <")).toBe(6);
    expect(safeEmitLength("Hello <fin")).toBe(6);
    expect(safeEmitLength("Hello <fina")).toBe(6);
    expect(safeEmitLength("Hello <final")).toBe(6);
  });

  it("holds back any </final>-prefix suffix so split closing tags get stripped", () => {
    expect(safeEmitLength("Hello </")).toBe(6);
    expect(safeEmitLength("Hello </fin")).toBe(6);
    expect(safeEmitLength("Hello </final")).toBe(6);
  });

  it("picks the longest hold across all patterns", () => {
    // "Hello <fin" — `<fin` (4) is a <final>-prefix, longer than any
    // NO_REPLY match (`n` is lowercase so the only candidate is empty).
    expect(safeEmitLength("Hello <fin")).toBe(6);
    // "Hello NO" — `NO` (2) is a NO_REPLY-prefix, no <final>-prefix.
    expect(safeEmitLength("Hello NO")).toBe(6);
  });

  it("holds back a partial control token so split harmony markers never leak", () => {
    // `<chan` is a prefix of the control token `<channel|>` — hold it until the
    // next chunk completes (and strips) the token, instead of emitting `<chan`.
    expect(safeEmitLength("Hello <chan")).toBe(6);
    expect(safeEmitLength("Hello <|chan")).toBe(6);
    expect(safeEmitLength("Hello <|message")).toBe(6);
  });
});

describe("stripControlTokens", () => {
  it("removes the single-pipe channel marker that leaked into chat (2026-06)", () => {
    expect(stripControlTokens("<channel|>")).toBe("");
    expect(stripControlTokens("Here is the result<channel|> done")).toBe("Here is the result done");
  });

  it("removes harmony-style double-pipe control tokens", () => {
    expect(stripControlTokens("<|channel|>")).toBe("");
    expect(stripControlTokens("<|message|>hi<|end|>")).toBe("hi");
    expect(stripControlTokens("<|start|>x<|return|>")).toBe("x");
  });

  it("strips a token assembled across chunk boundaries (operates on the buffer)", () => {
    expect(stripControlTokens("ok <|chan" + "nel|> more")).toBe("ok  more");
  });

  it("leaves normal prose and comparisons untouched", () => {
    expect(stripControlTokens("Use a < b and c > d here")).toBe("Use a < b and c > d here");
    expect(stripControlTokens("the F# pipe x |> f")).toBe("the F# pipe x |> f");
    expect(stripControlTokens("no tokens here")).toBe("no tokens here");
  });

  it("returns empty string for an empty buffer", () => {
    expect(stripControlTokens("")).toBe("");
  });
});

describe("stripFinalEnvelope", () => {
  it("removes opening and closing final tags", () => {
    expect(stripFinalEnvelope("<final>Hello</final>")).toBe("Hello");
  });

  it("removes tags that span what would otherwise be split chunks", () => {
    // Buffer-level stripping must catch tags assembled from multiple chunks.
    expect(stripFinalEnvelope("<fin" + "al>" + "Hi" + "</fi" + "nal>")).toBe("Hi");
  });

  it("leaves text without tags unchanged", () => {
    expect(stripFinalEnvelope("Hello world")).toBe("Hello world");
  });

  it("returns empty string for an empty buffer", () => {
    expect(stripFinalEnvelope("")).toBe("");
  });
});
