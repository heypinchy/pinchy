import { posix } from "node:path";
import { hiddenCharIn, isJoiner, isSpaceSeparator } from "./hidden-chars";
import { markedFormatOffsets } from "./emoji-sequence";

/** Longest path accepted. Far past any real one; short enough to show whole. */
const MAX_PATH_LENGTH = 1024;

/**
 * The path with the zero-width format characters taken out where the card
 * shows them as they are: inside a full RGI emoji (`emoji-sequence.ts`) — so
 * `⚠️ offen.md` must be writable (fifth review of #1242). A presentation
 * selector anywhere else is left in place for `hiddenCharIn` to refuse: it
 * draws nothing a file name needs, and `✅\uFE0F.md` next to `✅.md` would be
 * two files (sixth review). A joiner anywhere else is left in place too, and
 * accepted there (`isJoiner`): Arabic-script and Indic names carry one, and
 * the card marks it (tenth review).
 */
function withoutEmojiFormatChars(value: string): string {
  const marked = markedFormatOffsets(value);
  return value.replace(/[\u200C\u200D\uFE0E\uFE0F]/g, (char: string, offset: number) =>
    marked.has(offset) ? char : ""
  );
}

/** A file or folder name that starts or ends with a space of any kind. */
const PADDED_SEGMENT = /^\s|\s$/u;

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
 *   "Screenshot … at 10.00.00 AM.png".
 *   The joiners U+200C / U+200D are allowed anywhere too, as Arabic-script
 *   and Indic names need: the card marks each one outside an emoji, so
 *   `a\u200Db.md` reads as `a⟨U+200D⟩b.md`, never as `ab.md` (tenth review
 *   of #1242);
 * - no file or folder name that starts or ends with a space of any kind —
 *   `report.md ` would be a different file from `report.md`, and the card can
 *   only mark the space, not make the two read apart at a glance (sixth
 *   review). Unless `trimmedByTool`: a tool that trims the name itself
 *   (`pinchy_generate_file`) writes the one file either spelling names;
 * - NFC only — an NFD path renders exactly like its NFC twin, and on a Linux
 *   filesystem the two can be two different files. A file stored under an NFD
 *   name is still reached through its NFC spelling (`resolveOnDiskPath`).
 *
 * Every error says why, so the model can send the plain form.
 */
export function assertPlainPath(
  value: string,
  field: string,
  { trimmedByTool = false }: { trimmedByTool?: boolean } = {}
): void {
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(
      `${field} is longer than ${MAX_PATH_LENGTH} characters (${value.length}). ` +
        "Use a shorter path."
    );
  }
  const hidden = hiddenCharIn(
    withoutEmojiFormatChars(value),
    (char) => isSpaceSeparator(char) || isJoiner(char)
  );
  if (hidden) {
    throw new Error(
      `${field} contains an invisible or blank-rendering character (${hidden}). ` +
        "Use the plain path, without such characters."
    );
  }
  const padded = trimmedByTool
    ? undefined
    : value.split("/").find((segment) => PADDED_SEGMENT.test(segment));
  if (padded !== undefined) {
    throw new Error(
      `${field} has a space at the start or end of a file or folder name ` +
        `(${JSON.stringify(padded)}). Name it without the surrounding spaces.`
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
