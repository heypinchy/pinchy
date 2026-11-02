import { posix } from "node:path";
import { hiddenCharIn, isSpaceSeparator } from "./hidden-chars";

/** Longest path accepted. Far past any real one; short enough to show whole. */
const MAX_PATH_LENGTH = 1024;

/**
 * Refuses a path a write tool is asked to change unless it reads as exactly
 * the file it resolves to (second and third review of #1242).
 *
 * The confirmation card shows the path the agent sent. The second review's
 * probe was `/data/reports/old-draft.md` + 180 × U+2800 +
 * `/../../contracts/signed.pdf`: the braille blanks render as empty space and
 * pushed the traversal out of view, and `..` then walked the write from
 * reports/ into contracts/. The third review's was `/data/output/` + 2,100 ×
 * `./` + `contracts/signed.pdf`. So, at the tool's own edge and before
 * `validateAccess` resolves anything:
 *
 * - at most MAX_PATH_LENGTH characters;
 * - no `..` segment — the path names its target directly or not at all;
 * - its plain form only: no `.` segment, no empty segment (`//`), no trailing
 *   `/` — the path must equal `path.posix.normalize` of itself, so no filler
 *   can make it longer than the file it names;
 * - no character that renders as nothing or as blank space (`hidden-chars.ts`:
 *   controls, zero-width and bidi characters, line separators, Hangul
 *   fillers, the braille blank). Space separators (`\p{Zs}`: no-break, narrow
 *   no-break, ideographic) are allowed: they take visible width, the card
 *   prints each as `⟨U+XXXX⟩`, and real file names carry them — macOS writes
 *   "Screenshot … at 10.00.00 AM.png";
 * - NFC only — an NFD path renders exactly like its NFC twin, and on a Linux
 *   filesystem the two can be two different files. A file stored under an NFD
 *   name is still reached through its NFC spelling (`resolveOnDiskPath`).
 *
 * Every error says why, so the model can send the plain form.
 */
export function assertPlainPath(value: string, field: string): void {
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(
      `${field} is longer than ${MAX_PATH_LENGTH} characters (${value.length}). ` +
        "Use a shorter path."
    );
  }
  const hidden = hiddenCharIn(value, isSpaceSeparator);
  if (hidden) {
    throw new Error(
      `${field} contains an invisible or blank-rendering character (${hidden}). ` +
        "Use the plain path, without such characters."
    );
  }
  if (value !== value.normalize("NFC")) {
    throw new Error(
      `${field} is not in Unicode NFC form (composed characters, e.g. "ü" as one character). ` +
        "Send the composed form of the path."
    );
  }
  if (value.split(/[\\/]/).includes("..")) {
    throw new Error(`${field} must not contain a ".." segment. Name the target path directly.`);
  }
  const segments = value.split("/");
  const inner = value.startsWith("/") ? segments.slice(1) : segments;
  if (
    inner.some((segment) => segment === "" || segment === ".") ||
    value !== posix.normalize(value)
  ) {
    const plain = plainForm(value);
    throw new Error(
      `${field} must be written in its plain form: no "." segments, no empty segments ("//") ` +
        `and no trailing "/".` +
        (plain && plain !== "." ? ` Send it as ${JSON.stringify(plain)}.` : "")
    );
  }
}

/** What the model should have sent: the normalized path, without a trailing `/`. */
function plainForm(value: string): string {
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
