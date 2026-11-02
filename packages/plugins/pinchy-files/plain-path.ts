import { hiddenCharIn } from "./hidden-chars";

/**
 * Refuses a path a write tool is asked to change unless it reads as exactly
 * the file it resolves to (second review of #1242).
 *
 * The confirmation card shows the path the agent sent. The review's probe was
 * `/data/reports/old-draft.md` + 180 × U+2800 + `/../../contracts/signed.pdf`:
 * the braille blanks render as empty space and pushed the traversal out of
 * view, and `..` then walked the write from reports/ into contracts/. So, at
 * the tool's own edge and before `validateAccess` resolves anything:
 *
 * - no `..` segment — the path names its target directly or not at all;
 * - no character that renders as nothing or as blank space (`hidden-chars.ts`:
 *   controls, zero-width and bidi characters, non-plain spaces, Hangul
 *   fillers, the braille blank);
 * - NFC only — an NFD path renders exactly like its NFC twin, and on a Linux
 *   filesystem the two can be two different files.
 *
 * Every error says why, so the model can send the plain form.
 */
export function assertPlainPath(value: string, field: string): void {
  const hidden = hiddenCharIn(value);
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
}
