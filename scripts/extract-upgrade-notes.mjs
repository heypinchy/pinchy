#!/usr/bin/env node
/**
 * Extracts the upgrade-notes section for a release from upgrading.mdx
 * and writes it to stdout. Used by the release workflow to prepend the
 * section to the auto-generated GitHub Release body.
 *
 * Usage: node scripts/extract-upgrade-notes.mjs <prev-version> <target-version>
 *   e.g. node scripts/extract-upgrade-notes.mjs 0.4.4 0.5.0
 *
 * Writes the trimmed section body (with %%PINCHY_VERSION%% resolved to
 * v<target>) to stdout. If no matching section is found, writes nothing
 * and exits 0 — missing notes is not a release-blocking error at this
 * stage; the release script's assertUpgradingSectionExists gate runs
 * earlier and would have rejected a missing section.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUpgradeNotes } from "./lib/release-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const [, , prev, target] = process.argv;
if (!prev || !target) {
  process.stderr.write(
    "Usage: extract-upgrade-notes.mjs <prev-version> <target-version>\n",
  );
  process.exit(1);
}

const mdxPath = resolve(ROOT, "docs/src/content/docs/guides/upgrading.mdx");
const mdx = readFileSync(mdxPath, "utf8");
process.stdout.write(extractUpgradeNotes(mdx, prev, target));
