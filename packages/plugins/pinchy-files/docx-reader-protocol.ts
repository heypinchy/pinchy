// The messages between `docx-extract.ts` and its reader child. Types only:
// the child imports this with `import type`, which Node's type stripping
// erases, so nothing here may exist at runtime.

/** What the child is asked to do: one conversion, then it exits. */
export interface DocxReaderRequest {
  /** The VERIFIED copy of the .docx (`verifiedZipCopy`), never the original. */
  data: Uint8Array;
  maxTextBytes: number;
}

/** Every message the child sends. */
export type DocxReaderMessage =
  { type: "ready" } | { type: "result"; text: string } | { type: "failure"; message: string };
