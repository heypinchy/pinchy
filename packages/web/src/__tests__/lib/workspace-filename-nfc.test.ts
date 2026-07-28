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
// What this file enforces is COVERAGE, not behaviour: every module under
// SCAN_ROOTS that writes a file must be classified — either it mints workspace
// filenames (and then it normalizes), or it doesn't (and then the reason is
// written down). The per-boundary behaviour is already asserted where the code
// lives:
//
//   - packages/web/src/__tests__/lib/upload-validation.test.ts
//   - packages/plugins/pinchy-email/__tests__/tools.test.ts
//   - packages/plugins/pinchy-files/index.test.ts (generate + write fallback)
//   - packages/plugins/pinchy-files/unicode-path.test.ts (read fallback)
//
// Known limitations, same shape as the test-deletion guard — this is a
// tripwire, not a proof:
//
//   - Detection is a regex over source text, so a write call inside a comment
//     or a string literal counts. That errs toward demanding a classification,
//     which is the safe direction.
//   - It only sees the spellings in WRITE_CALL_RE. A file created via
//     `open(path, "wx")`, an fs-extra helper, or a write reached through a
//     renamed binding is invisible — add the spelling when one appears.
//   - It scans SCAN_ROOTS only. Neither `scripts/` nor `config/` writes into an
//     agent workspace today; if one ever does, add its root here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "../../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

/**
 * Where write boundaries can live. `packages/web/src` is not optional: the
 * risk this guard exists for is the NEXT boundary, and a new channel
 * integration is at least as likely to land in the web app as in a plugin —
 * today's browser-upload boundary already does.
 */
const SCAN_ROOTS = ["packages/web/src", "packages/plugins"];

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
  "packages/web/src/lib/uploads.ts": {
    via: "@/lib/upload-validation",
    why: "this is the module that actually puts the uploaded name on disk (staging write + promote rename). The upload route composes via sanitizeFilename before staging, and promoteStagedToAttached applies it again on the way to uploads/",
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
 * Modules that write files but never mint a workspace filename from an external
 * name — fixed paths, literal basenames, or format-validated ids. An entry here
 * is a claim that has to stay true, so the "does not lie" test below re-checks
 * that the module still writes at all.
 */
const NOT_A_NAME_BOUNDARY: Record<string, string> = {
  "packages/web/src/lib/encryption.ts":
    "persists an auto-generated key at a fixed key-file path; the content is random hex and the name comes from config, never from a request.",
  "packages/web/src/lib/openclaw-config/agent-auth-profiles.ts":
    "rewrites the fixed auth-profiles JSON through a tmp path + rename.",
  "packages/web/src/lib/openclaw-config/build.ts":
    "parks a rejected config payload at `<CONFIG_PATH>.regenerate-rejected.<ISO timestamp>` for postmortem — a constant plus a timestamp.",
  "packages/web/src/lib/openclaw-config/write.ts":
    "writes openclaw.json through a fixed tmp path + rename.",
  "packages/web/src/lib/openclaw-migration.ts": "writes a fixed migration marker file.",
  "packages/web/src/lib/openclaw-secrets.ts":
    "rewrites the fixed secrets bundle through a tmp path + rename.",
  "packages/web/src/lib/secure-cookies.ts":
    "writes the cookie-domain file at a fixed path; the external string is the file's CONTENT, not its name.",
  "packages/web/src/lib/session-migration.ts": "rewrites OpenClaw's fixed sessions.json in place.",
  "packages/web/src/lib/telegram-allow-store.ts":
    "rewrites the fixed allow-store JSON through a tmp path + rename.",
  "packages/web/src/lib/workspace.ts":
    "writes agent bootstrap files under literal basenames (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, skills/<skillId>/SKILL.md). agentId and skillId are format-validated, and writeWorkspaceFile additionally allowlists the basename via assertAllowedFile.",
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

const SKIPPED_DIRS = ["node_modules", "dist", ".next", "__fixtures__", "__tests__"];

function walkSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.includes(entry)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    result.push(fullPath);
  }
  return result;
}

/** Every source file under SCAN_ROOTS that writes a file, repo-relative and sorted. */
function writeSites(): string[] {
  return SCAN_ROOTS.flatMap((root) => walkSourceFiles(resolve(REPO_ROOT, root)))
    .filter((file) => WRITE_CALL_RE.test(readFileSync(file, "utf-8")))
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

/**
 * Resolve a boundary's `via` specifier to the repo-relative module it names, so
 * the delegation target is checked by identity rather than by filename suffix —
 * two packages may well both hold a `deliverable-filename.ts`.
 */
function resolveVia(importer: string, specifier: string): string {
  const base = specifier.startsWith("@/")
    ? join("packages/web/src", specifier.slice(2))
    : join(dirname(importer), specifier);
  return `${base}.ts`;
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

    // hasOwn, not `in` / index access: a `via` resolving to "constructor" or
    // "toString" would otherwise find a truthy prototype member and pass.
    const target = resolveVia(file, boundary.via!);
    expect(
      Object.hasOwn(NFC_BOUNDARIES, target),
      `${file} delegates to ${target}, which is not itself a registered boundary`
    ).toBe(true);
    expect(read(target)).toContain(NFC_CALL);
  });

  it("classifies every module that writes files", () => {
    const classified = new Set([
      ...Object.keys(NFC_BOUNDARIES),
      ...Object.keys(NOT_A_NAME_BOUNDARY),
    ]);
    const unclassified = writeSites().filter((file) => !classified.has(file));

    expect(
      unclassified,
      "These modules write files but are not classified in workspace-filename-nfc.test.ts.\n" +
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
    const writers = new Set(writeSites());
    const stale = Object.keys(NOT_A_NAME_BOUNDARY).filter((file) => !writers.has(file));
    expect(stale, "Exempted modules that no longer write files — drop the entry").toEqual([]);
  });

  it("classifies each module exactly once", () => {
    const both = Object.keys(NFC_BOUNDARIES).filter((file) =>
      Object.hasOwn(NOT_A_NAME_BOUNDARY, file)
    );
    expect(both, "A module cannot be both a name boundary and not one").toEqual([]);
  });
});
