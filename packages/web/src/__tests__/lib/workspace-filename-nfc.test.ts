// @vitest-environment node
//
// (This guard only reads source files; the default jsdom environment costs
// ~35s of setup per run for a DOM nothing here touches.)
//
// Drift guard for AGENTS.md § "Workspace Filenames Are NFC At Every Write
// Boundary" (#829).
//
// Five fixes since v0.8.0 converged on one convention: a filename that comes
// from outside — a browser upload, an email attachment, a name the model typed
// — is NFC-normalized at the moment it becomes a workspace filename, and the
// tolerant as-given → NFC → NFD read fallback in pinchy-files exists only for
// files written before that convention held. Until this guard, the convention
// lived in cross-referencing comments, so the NEXT write boundary (a new
// channel, a new plugin saving user-named files) had nothing forcing it to
// normalize and could reintroduce the macOS dead-key/umlaut bug class.
//
// What this file enforces is COVERAGE, not behaviour: every plugin module that
// writes a file must be classified — either it mints workspace filenames (and
// then it normalizes), or it doesn't (and then the reason is written down).
// The per-boundary behaviour is already asserted where the code lives:
//
//   - packages/web/src/__tests__/lib/upload-validation.test.ts
//   - packages/plugins/pinchy-email/__tests__/tools.test.ts
//   - packages/plugins/pinchy-files/index.test.ts (generate + write fallback)
//   - packages/plugins/pinchy-files/unicode-path.test.ts (read fallback)
//
// Known limitation, same shape as the test-deletion guard: the write-call
// detection is a regex over source text, so a write call inside a comment or a
// string literal counts. That errs toward demanding a classification, which is
// the safe direction.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "../../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const PLUGINS_ROOT = resolve(REPO_ROOT, "packages/plugins");

/**
 * Modules that turn an externally-supplied name into a workspace filename.
 * Each must normalize, either itself (`.normalize("NFC")`) or by importing a
 * module in this same map (`via`).
 *
 * The two sanitizers are near-duplicates on purpose: plugins cannot import from
 * packages/web, and their policies differ deliberately — the web one REJECTS
 * (the uploader can pick another name), the email one SANITIZES (the sender
 * picks the name and there is nobody to ask).
 */
const NFC_BOUNDARIES: Record<string, { why: string; via?: string }> = {
  "packages/web/src/lib/upload-validation.ts": {
    why: "browser/API uploads: macOS submits NFD multipart filenames; sanitizeFilename composes before the name reaches disk, the DB row, and the path the agent is shown",
  },
  "packages/plugins/pinchy-email/index.ts": {
    why: "email attachment filenames are sender-supplied and land in the agent workspace verbatim; sanitizeNameToken composes them",
  },
  "packages/plugins/pinchy-files/deliverable-filename.ts": {
    why: "agent-generated deliverables (#788): the name must be a fixed point of the web serve route's sanitizer, which composes — an NFD name would never match its own download grant",
  },
  "packages/plugins/pinchy-files/index.ts": {
    via: "./deliverable-filename",
    why: "pinchy_generate_file mints names through normalizeDeliverableBasename. pinchy_write is deliberately NOT a minting boundary: it writes the path the caller passed and uses resolveOnDiskPath so an NFC request lands on a legacy NFD file instead of duplicating it",
  },
};

/**
 * Plugin modules that write files but never mint a workspace filename from an
 * external name. An entry here is a claim that has to stay true — see the
 * "does not lie" test below.
 */
const NOT_A_NAME_BOUNDARY: Record<string, string> = {
  "packages/plugins/pinchy-transcript/index.ts":
    "media mirror: it COPIES a file that already exists in OpenClaw's inbound store and keeps that store's basename byte-for-byte. Composing the target would make the mirrored name differ from the source name it is audited under, for no gain — the model never types this name blind, and pinchy-files' read fallback resolves it either way.",
  "packages/plugins/pinchy-files/generate-docx-fixtures.ts":
    "dev-only fixture generator with literal ASCII names; never runs in production and writes into __fixtures__, not a workspace.",
  "packages/plugins/pinchy-files/generate-test-fixtures.ts":
    "dev-only fixture generator with literal ASCII names; never runs in production and writes into __fixtures__, not a workspace.",
};

// Filesystem calls that put bytes under a chosen name. Directory creation is
// excluded: no code here derives a directory name from an external string.
const WRITE_CALL_RE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|createWriteStream|rename|renameSync)\s*\(/;

const NFC_CALL = '.normalize("NFC")';

function walkSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "__fixtures__", "__tests__"].includes(entry)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (/\.(test|spec)\.ts$/.test(entry)) continue;
    result.push(fullPath);
  }
  return result;
}

/** Every plugin source file that writes a file, repo-relative and sorted. */
function pluginWriteSites(): string[] {
  return walkSourceFiles(PLUGINS_ROOT)
    .filter((file) => WRITE_CALL_RE.test(readFileSync(file, "utf-8")))
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

function read(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), "utf-8");
}

describe("workspace filenames are NFC at every write boundary", () => {
  it.each(Object.entries(NFC_BOUNDARIES))("%s normalizes to NFC", (file, boundary) => {
    const source = read(file);
    if (source.includes(NFC_CALL)) return;

    // A boundary may delegate the normalization to another listed boundary
    // (pinchy-files/index.ts → deliverable-filename.ts) rather than repeat it.
    expect(
      boundary.via,
      `${file} is registered as a workspace-filename boundary but contains no ${NFC_CALL} and declares no \`via\`.\n` +
        `Reason on file: ${boundary.why}`
    ).toBeDefined();
    expect(source, `${file} declares \`via: "${boundary.via}"\` but does not import it`).toContain(
      `"${boundary.via}"`
    );

    const target = Object.keys(NFC_BOUNDARIES).find((candidate) =>
      candidate.endsWith(`${boundary.via!.replace(/^\.\//, "")}.ts`)
    );
    expect(target, `${file}'s \`via\` target is not itself a registered boundary`).toBeDefined();
    expect(read(target!)).toContain(NFC_CALL);
  });

  it("classifies every plugin module that writes files", () => {
    const classified = new Set([
      ...Object.keys(NFC_BOUNDARIES),
      ...Object.keys(NOT_A_NAME_BOUNDARY),
    ]);
    const unclassified = pluginWriteSites().filter((file) => !classified.has(file));

    expect(
      unclassified,
      "These plugin modules write files but are not classified in workspace-filename-nfc.test.ts.\n" +
        "If the module turns an external name into a workspace filename, NFC-normalize it and add it to\n" +
        "NFC_BOUNDARIES. If it doesn't, add it to NOT_A_NAME_BOUNDARY with the reason.\n" +
        "See AGENTS.md § 'Workspace Filenames Are NFC At Every Write Boundary'."
    ).toEqual([]);
  });

  it("does not lie: every classified module exists, and every exemption still writes", () => {
    // A classification that outlives its code is worse than none — it reads as
    // "this was considered" when the code it described is gone or has moved.
    for (const file of [...Object.keys(NFC_BOUNDARIES), ...Object.keys(NOT_A_NAME_BOUNDARY)]) {
      expect(() => read(file), `${file} is classified but does not exist`).not.toThrow();
    }

    // An exemption is a claim about a module that WRITES files. Boundaries are
    // not checked this way: deliverable-filename.ts mints the name that
    // pinchy-files/index.ts then writes, and never touches the filesystem
    // itself.
    const writeSites = new Set(pluginWriteSites());
    const stale = Object.keys(NOT_A_NAME_BOUNDARY).filter((file) => !writeSites.has(file));
    expect(stale, "Exempted modules that no longer write files — drop the entry").toEqual([]);
  });

  it("classifies each module exactly once", () => {
    const both = Object.keys(NFC_BOUNDARIES).filter((file) => file in NOT_A_NAME_BOUNDARY);
    expect(both, "A module cannot be both a name boundary and not one").toEqual([]);
  });
});
