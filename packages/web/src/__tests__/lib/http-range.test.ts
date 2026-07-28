/**
 * Byte-range parsing for the workspace-file serving route.
 *
 * This exists because a knowledge-base corpus contains genuinely large PDFs —
 * the Noack corpus has a 268 MB and a 174 MB scanned compilation binder, and
 * those two are also the most-cited documents in it. Serving them means never
 * materialising the file in memory, and it means answering range requests:
 * a browser PDF viewer asked to open at `#page=510` fetches the trailer, then
 * the pages it needs, and downloads a fraction of the file instead of all of it.
 *
 * The parse is deliberately conservative. Anything this module does not
 * understand — a multi-range request, a non-`bytes` unit, a malformed value —
 * resolves to `full`, which is an explicitly allowed server response (RFC 9110
 * §14.2: "A server MAY ignore the Range header field"). Only a syntactically
 * VALID range that cannot be satisfied against the real file length becomes
 * `unsatisfiable`, because that one has to be a 416 to keep a viewer from
 * silently rendering the wrong bytes.
 */
import { describe, it, expect } from "vitest";

import { parseRangeHeader } from "@/lib/http-range";

const SIZE = 1000;

describe("parseRangeHeader", () => {
  it("treats a missing header as a request for the whole file", () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "full" });
  });

  it("reads a closed range as an inclusive byte span", () => {
    // Inclusive on both ends per RFC 9110 — `bytes=0-99` is 100 bytes, not 99.
    // Getting this wrong truncates every chunk a PDF viewer asks for.
    expect(parseRangeHeader("bytes=0-99", SIZE)).toEqual({ kind: "partial", start: 0, end: 99 });
  });

  it("reads an open-ended range as running to the last byte", () => {
    expect(parseRangeHeader("bytes=500-", SIZE)).toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("reads a suffix range as the last N bytes", () => {
    // How a PDF viewer finds the cross-reference table: it asks for the tail
    // first, without knowing where the file's structures begin.
    expect(parseRangeHeader("bytes=-500", SIZE)).toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("clamps a suffix longer than the file to the whole file", () => {
    expect(parseRangeHeader("bytes=-5000", SIZE)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("clamps an end past the last byte instead of over-reading", () => {
    expect(parseRangeHeader("bytes=900-99999", SIZE)).toEqual({
      kind: "partial",
      start: 900,
      end: 999,
    });
  });

  it("reads a single-byte range as one byte, not as an empty span", () => {
    // `bytes=0-0` is how some clients probe whether range support is real.
    // Collapsing it to empty would make that probe conclude it is not.
    expect(parseRangeHeader("bytes=0-0", SIZE)).toEqual({ kind: "partial", start: 0, end: 0 });
  });

  it("serves the final byte of the file as a valid range", () => {
    expect(parseRangeHeader("bytes=999-999", SIZE)).toEqual({
      kind: "partial",
      start: 999,
      end: 999,
    });
  });

  it("rejects a start at or past the end of the file", () => {
    // Must be 416, not a silent empty 206: a viewer that gets zero bytes where
    // it expected content renders a corrupt document rather than an error.
    expect(parseRangeHeader("bytes=1000-1099", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects a range whose start is past its end", () => {
    expect(parseRangeHeader("bytes=500-100", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects any range against an empty file", () => {
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a zero-length suffix request", () => {
    // `bytes=-0` asks for the last zero bytes. RFC 9110 calls it unsatisfiable;
    // serving the whole file is the safe reading and matches what nginx does.
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "full" });
  });

  it("ignores a multi-range request rather than answering only its first part", () => {
    // Answering `bytes=0-99,200-299` with just 0-99 while claiming 206 would
    // hand the client bytes it did not ask for at offsets it did not expect.
    // A multipart/byteranges body is the only correct 206 here, so we decline
    // the whole optimisation and send the complete file instead.
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toEqual({ kind: "full" });
  });

  it("ignores a unit other than bytes", () => {
    expect(parseRangeHeader("items=0-99", SIZE)).toEqual({ kind: "full" });
  });

  it.each(["bytes=", "bytes=-", "bytes=abc-def", "bytes=1.5-2", "0-99", ""])(
    "ignores the malformed value %j",
    (header) => {
      expect(parseRangeHeader(header, SIZE)).toEqual({ kind: "full" });
    }
  );

  it("ignores a range whose numbers exceed what a byte offset can be", () => {
    // Beyond Number.MAX_SAFE_INTEGER the arithmetic stops being exact, and an
    // inexact offset would be passed straight to a file read.
    expect(parseRangeHeader("bytes=99999999999999999999-", SIZE)).toEqual({ kind: "full" });
  });

  it("tolerates the optional whitespace a client may send", () => {
    expect(parseRangeHeader("bytes = 0-99", SIZE)).toEqual({ kind: "partial", start: 0, end: 99 });
  });
});
