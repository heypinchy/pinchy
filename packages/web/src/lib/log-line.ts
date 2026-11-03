/**
 * Text that did not come from us, made safe to print inside one server-log
 * line.
 *
 * A file name is whatever whoever put the file on a share chose — newlines,
 * line separators and bidi controls included — and an error about that file
 * quotes it: a file-system error in its message and stack, a reader's error in
 * its message. Printed as it stands, either writes lines of its own into the
 * server log — which an operator reads, and whose recent warnings and errors
 * an admin reads in the diagnostics export (`logs` in `/api/diagnostics`). So
 * a line that names a path, a file or an error derived from one prints it
 * through `oneLine` or `errorLine`: one log call, one bounded line.
 *
 * The escape rule itself is the zip guard's (`escapeLineBreaking`), so the log
 * and a refusal's quote of a name inside a file cannot drift apart.
 */
import { inspect } from "node:util";

import { escapeLineBreaking } from "../../../plugins/pinchy-files/docx-zip-guard";

/** How much of a path a log line prints. */
export const LOG_PATH_MAX = 1024;
/** How much of a reason a log line prints. */
export const LOG_REASON_MAX = 500;
/** How much of an error — message, code and stack — a log line prints. */
export const LOG_ERROR_MAX = 2048;

/**
 * `text` as part of one log line, at most `max` characters: whatever would
 * break or reorder the line is printed as its escape, and `…` marks a cut. An
 * escape is never split by the cut.
 */
export function oneLine(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    const piece = escapeLineBreaking(char);
    if (out.length + piece.length > max) return `${out}…`;
    out += piece;
  }
  return out;
}

/**
 * Whatever was thrown, as part of one log line: what failed first — each
 * Error's name, message and code, down its chain of causes — then where, the
 * outermost error's stack frames. Escaped and bounded, so it still says what
 * failed and where without writing a line of its own; the order means a cut
 * costs frames before it costs a cause.
 */
export function errorLine(err: unknown, max: number = LOG_ERROR_MAX): string {
  const frames = err instanceof Error ? stackFrames(err) : [];
  const where = frames.length > 0 ? ` — ${frames.join(" ← ")}` : "";
  return oneLine(`${describeChain(err, 0)}${where}`, max);
}

/** How many causes deep `errorLine` follows a chain. */
const MAX_CAUSE_DEPTH = 4;

function describeChain(err: unknown, depth: number): string {
  if (!(err instanceof Error)) return inspect(err, { breakLength: Infinity, depth: 2 });
  const code = (err as NodeJS.ErrnoException).code;
  const head = `${err.name}: ${err.message}${typeof code === "string" ? ` [${code}]` : ""}`;
  if (err.cause === undefined || depth >= MAX_CAUSE_DEPTH) return head;
  return `${head} — caused by ${describeChain(err.cause, depth + 1)}`;
}

/** The `at …` lines of an Error's stack, without the message it repeats. */
function stackFrames(err: Error): string[] {
  return (err.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
}
