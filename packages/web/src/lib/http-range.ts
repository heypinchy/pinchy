/**
 * Parses an HTTP `Range` request header into a concrete byte span.
 *
 * Why the workspace-file route needs this at all: a real knowledge-base corpus
 * contains scanned compilation binders in the hundreds of megabytes, and those
 * tend to be the MOST-cited documents in it (they contain the most). Opening a
 * citation at `#page=510` should not mean transferring the whole file — a
 * browser's PDF viewer fetches the trailer, reads the cross-reference table,
 * then pulls only the pages it renders, but it only does that when the server
 * advertises `Accept-Ranges: bytes` and honours the follow-up requests.
 *
 * The parse is deliberately conservative: anything not understood resolves to
 * `full`, which RFC 9110 §14.2 explicitly permits ("A server MAY ignore the
 * Range header field"). The one case that must NOT be silently downgraded is a
 * well-formed range that the file cannot satisfy — answering that with 200, or
 * with an empty 206, hands a viewer bytes at offsets it did not ask for, and it
 * renders a corrupt document rather than reporting an error.
 */

export type RangeRequest =
  /** Serve the entire file with 200. Also the answer for anything unparsed. */
  | { kind: "full" }
  /** Serve `[start, end]` INCLUSIVE with 206 — the same convention as HTTP and as `createReadStream`. */
  | { kind: "partial"; start: number; end: number }
  /** Syntactically valid, but outside the file. Must become 416. */
  | { kind: "unsatisfiable" };

const FULL: RangeRequest = { kind: "full" };

/**
 * A single `bytes=` range: `start-end`, `start-`, or `-suffix`. Digits only —
 * no signs, no decimals — because the captured text is turned straight into a
 * file offset. A comma anywhere makes this fail to match, which is how
 * multi-range requests fall through to `full`: answering only the first part
 * while claiming 206 would misplace every subsequent byte, and a correct answer
 * would need a `multipart/byteranges` body that no caller here wants.
 */
const SINGLE_BYTE_RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

export function parseRangeHeader(header: string | null, size: number): RangeRequest {
  if (!header) return FULL;

  const match = SINGLE_BYTE_RANGE.exec(header);
  if (!match) return FULL;

  const [, rawStart, rawEnd] = match;
  // `bytes=-` carries neither bound and means nothing.
  if (rawStart === "" && rawEnd === "") return FULL;

  // An empty file can satisfy no range at all, and the clamping below would
  // otherwise produce the nonsensical span [0, -1].
  if (size <= 0) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix form: `bytes=-500` is the LAST 500 bytes, not "up to byte 500".
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength)) return FULL;
    // `bytes=-0` requests the last zero bytes. Treated as unparseable rather
    // than unsatisfiable: there is no sane partial answer, and a 416 for what
    // is plainly a client bug would break an otherwise fine download.
    if (suffixLength === 0) return FULL;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start)) return FULL;
    if (rawEnd === "") {
      end = size - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isSafeInteger(end)) return FULL;
      // A client may ask past the end without knowing the length; serve what
      // exists rather than refusing.
      end = Math.min(end, size - 1);
    }
    // `end` is already clamped to the last byte, so this one comparison also
    // covers a start at or past the end of the file. An explicit `start >= size`
    // check next to it looks like belt and braces but is unreachable — a
    // mutation test proved nothing depended on it — and a second place deciding
    // the same thing is a pair that drifts.
    if (start > end) return { kind: "unsatisfiable" };
  }

  return { kind: "partial", start, end };
}
