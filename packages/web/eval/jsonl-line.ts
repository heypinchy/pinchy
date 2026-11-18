/**
 * One JSONL line, parsed so that a failure says WHERE it failed.
 *
 * `JSON.parse` throws `SyntaxError: Unexpected end of JSON input` and nothing
 * else — no file, no line — which is the least useful thing a reader over a
 * 49-line published dataset can say. And the failure is not hypothetical:
 * `appendFile` is not atomic, so a sweep killed mid-write leaves a truncated
 * last line, and `data/` is filled by copying that file.
 *
 * Same contract as the throw-on-unknown-axis rule next to it: a reader that
 * cannot read its input must name what it choked on, because the alternative
 * — a short list, or an error nobody can act on — reads as "there was nothing
 * wrong there".
 */
export function parseJsonlLine(file: string, lineNo: number, line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(
      `${file} line ${lineNo}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`
    );
  }
}
