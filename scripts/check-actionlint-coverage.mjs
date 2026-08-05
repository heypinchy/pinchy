#!/usr/bin/env node
/**
 * actionlint input-coverage guard (CI, and runnable locally).
 *
 * The actionlint step in ci.yml's `quality` job catches a wrong `with:` key —
 * but only for action versions actionlint has a schema for. For anything else
 * it says nothing, and nothing is indistinguishable from clean.
 *
 * This measures which is which: one throwaway workflow per action, each with an
 * input that cannot exist, fed to the same actionlint binary CI runs. An action
 * whose coverage is missing must either be fixed (bump actionlint) or accepted
 * with a reason in scripts/lib/actionlint-coverage.mjs.
 *
 * Usage:
 *   node scripts/check-actionlint-coverage.mjs
 *   ACTIONLINT_BIN=/path/to/actionlint node scripts/check-actionlint-coverage.mjs
 *
 * Not a vitest guard: it needs the actionlint binary, which `pnpm test:scripts`
 * has no way to guarantee. The pure logic it depends on IS unit-tested there
 * (scripts/lib/actionlint-coverage.test.mjs).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProbeWorkflow,
  classifyCoverage,
  extractActionRefs,
  formatFailure,
  probeReportedInput,
} from "./lib/actionlint-coverage.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const actionlintBin = process.env.ACTIONLINT_BIN || "actionlint";

/** Every *.yml / *.yaml under .github/, recursively. */
function collectYamlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectYamlFiles(full));
    } else if (/\.ya?ml$/.test(entry)) {
      out.push({ path: full, content: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const files = collectYamlFiles(path.join(repoRoot, ".github"));
const used = extractActionRefs(files);

// A synthetic workflow needs its own .github/workflows/ — actionlint resolves
// the project root from the file's path and refuses a bare file elsewhere.
const probeRoot = mkdtempSync(path.join(tmpdir(), "actionlint-coverage-"));
const probeDir = path.join(probeRoot, ".github", "workflows");
mkdirSync(probeDir, { recursive: true });
const probeFile = path.join(probeDir, "probe.yml");

const checked = [];
for (const ref of used) {
  writeFileSync(probeFile, buildProbeWorkflow(ref));
  let output = "";
  try {
    output = execFileSync(
      actionlintBin,
      ["-no-color", "-oneline", "-shellcheck=", "-pyflakes=", probeFile],
      { encoding: "utf8", cwd: probeRoot },
    );
  } catch (err) {
    // actionlint exits non-zero whenever it reports anything, which is the
    // expected outcome for a covered action. Its findings are on stdout.
    if (err.stdout === undefined && err.stderr === undefined) {
      console.error(
        `Could not run '${actionlintBin}': ${err.message}\n` +
          `Install actionlint, or point ACTIONLINT_BIN at the binary.`,
      );
      process.exit(1);
    }
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (probeReportedInput(output)) checked.push(ref);
}

const { failures } = classifyCoverage({ used, checked });

if (failures.length > 0) {
  console.error(formatFailure(failures));
  process.exit(1);
}

console.log(
  `actionlint input coverage: ${checked.length}/${used.length} actions validated ` +
    `(${used.length - checked.length} accepted as unchecked).`,
);
