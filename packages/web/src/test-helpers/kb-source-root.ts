import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isArchivedPath } from "@/lib/knowledge/archive-paths";

const MAX_DRAWS = 20;

/**
 * A fresh temp directory to index as a knowledge-base source root in a test.
 *
 * Use this instead of a bare `mkdtempSync` for any root whose files get
 * ingested. The archive rule (`archive-paths.ts`) reads every directory segment
 * of a document's ABSOLUTE path, so the random six-character suffix is part of
 * what it classifies: a draw like `a7old2` holds the token `old`, every file
 * under the root becomes `archived`, and any test expecting `archived: 0` or
 * `status: "active"` fails at random.
 *
 * The rule itself is the oracle, so a word added to ARCHIVE_TOKENS later is
 * covered without touching this file. A parent or prefix that is archived on
 * its own throws: no suffix can make that root clean.
 */
export function makeKbSourceRoot(
  prefix: string,
  opts: { parent?: string; mkdtemp?: (prefix: string) => string } = {}
): string {
  const parent = opts.parent ?? tmpdir();
  const mkdtemp = opts.mkdtemp ?? mkdtempSync;

  if (isArchivedPath(join(parent, "probe"))) {
    throw new Error(
      `makeKbSourceRoot: parent ${parent} holds an archive word, so every file under it ` +
        "would be indexed as archived; point TMPDIR somewhere else"
    );
  }
  // A suffix of digits alone keeps the prefix's last token whole, so test the
  // prefix with one; an archive word in it would otherwise exhaust every draw.
  if (isArchivedPath(join(parent, `${prefix}0`, "probe"))) {
    throw new Error(`makeKbSourceRoot: prefix "${prefix}" holds an archive word`);
  }

  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const root = mkdtemp(join(parent, prefix));
    if (!isArchivedPath(join(root, "probe"))) return root;
    rmSync(root, { recursive: true, force: true });
  }
  throw new Error(
    `makeKbSourceRoot: ${MAX_DRAWS} draws under ${parent} all spelled an archive word`
  );
}
