import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Every `*_BASE_URL` / `*_MOCK_HOST` / `*_MOCK_PORT` env var in this repo exists
 * for one reason: to let an E2E stack redirect an outbound call to a local mock
 * server. Each one is therefore a switch that reroutes an authenticated request
 * — an OAuth client secret, a refresh token, an access token, an API key — to
 * whatever host it names. Left over in a production environment, unpaired with
 * an explicit opt-in, it does that silently.
 *
 * The pairing convention (`PINCHY_INSECURE_MAIL_MOCK=1`,
 * `PINCHY_INSECURE_WEB_MOCK=1`) has been in `imap-adapter.ts` since that seam
 * was written, and three later overrides simply did not adopt it. Nothing
 * noticed, because nothing was looking: AGENTS.md's own lesson is that the one
 * list with a guard (`contracts.tools`) is the one list that did not drift.
 *
 * This is that guard. It scans production source in `packages/web/src` and
 * `packages/plugins/pinchy-*` for override reads, and requires every var it
 * finds to be REGISTERED below and GATED where it is read. Both directions
 * fail: an unregistered var, and a registered var that no longer appears — a
 * verdict must not outlive its evidence.
 *
 * What it deliberately does not do is prove the gate *works*. That is the job
 * of the resolvers' own behavioural tests
 * (`insecure-mock-base-url.test.ts`, `email-adapter.test.ts`,
 * `brave-search.test.ts`) plus the per-call-site tests next to each consumer.
 * This guard proves nothing was left out of that set.
 */

const WEB_SRC = resolve(__dirname, "../..");
const PLUGINS_DIR = resolve(__dirname, "../../../../plugins");

/** Env vars whose whole purpose is to redirect an outbound call. */
const OVERRIDE_VAR_PATTERN = /^[A-Z][A-Z0-9_]*_(?:BASE_URL|MOCK_HOST|MOCK_PORT)$/;

/**
 * Functions that resolve an override AND enforce its flag internally. A read
 * that goes through one of these is gated by construction; a bare
 * `process.env.X` read is only gated if its own file also names the flag.
 */
const FLAG_ENFORCING_RESOLVERS = ["resolveInsecureMockBaseUrl", "resolveBraveBaseUrl"];

type Verdict = { gatedBy: string; note?: string } | { exempt: string };

/**
 * The registry. `gatedBy` names the flag that must accompany the override;
 * `exempt` records why a var needs no flag, in prose, because the reason is the
 * artefact (there is nothing to defer to a tracking issue).
 */
const OVERRIDE_REGISTRY: Record<string, Verdict> = {
  // --- Pinchy (web app): holds the OAuth client secret and refresh tokens. ---
  GMAIL_OAUTH_BASE_URL: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  MICROSOFT_OAUTH_BASE_URL: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  // Read by BOTH the web app (ports, probe, OAuth profile) and the
  // pinchy-email plugin's graph adapter — each with its own resolver.
  GRAPH_API_BASE_URL: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  GMAIL_API_BASE_URL: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },

  // --- Plugins (inside the OpenClaw container). ---
  IMAP_MOCK_HOST: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  IMAP_MOCK_PORT: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  SMTP_MOCK_HOST: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  SMTP_MOCK_PORT: { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" },
  BRAVE_API_BASE_URL: { gatedBy: "PINCHY_INSECURE_WEB_MOCK" },
};

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkSource(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".test-d.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function pluginSourceFiles(): string[] {
  return readdirSync(PLUGINS_DIR)
    .filter((entry) => entry.startsWith("pinchy-"))
    .flatMap((entry) => walkSource(join(PLUGINS_DIR, entry)));
}

interface Read {
  varName: string;
  file: string;
  /** true when the read went through a flag-enforcing resolver. */
  viaResolver: boolean;
}

/**
 * An override reaches the code in exactly two shapes, and the second one is the
 * reason a plain `grep process.env.` is not enough any more: once a read moves
 * behind `resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL")`, the var name lives
 * in a string literal and `process.env.GMAIL_API_BASE_URL` appears nowhere.
 */
function collectReads(files: string[]): Read[] {
  const reads: Read[] = [];
  const bare = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
  const viaResolver = new RegExp(
    `(?:${FLAG_ENFORCING_RESOLVERS.join("|")})\\(\\s*["']([A-Z][A-Z0-9_]*)["']`,
    "g"
  );

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(bare)) {
      const varName = m[1] ?? m[2];
      if (OVERRIDE_VAR_PATTERN.test(varName)) reads.push({ varName, file, viaResolver: false });
    }
    for (const m of src.matchAll(viaResolver)) {
      if (OVERRIDE_VAR_PATTERN.test(m[1])) reads.push({ varName: m[1], file, viaResolver: true });
    }
  }
  return reads;
}

const sourceFiles = [...walkSource(WEB_SRC), ...pluginSourceFiles()];
const reads = collectReads(sourceFiles);
const repoRoot = resolve(__dirname, "../../../../..");
const rel = (file: string) => relative(repoRoot, file);

describe("insecure-mock override coverage", () => {
  it("scans a real corpus", () => {
    // A walker that finds nothing would satisfy every check below in silence,
    // which is how a coverage gate becomes decoration.
    expect(sourceFiles.length).toBeGreaterThan(300);
    expect(reads.length).toBeGreaterThan(5);
  });

  it("registers every override var found in production source", () => {
    const unregistered = [...new Set(reads.map((r) => r.varName))]
      .filter((name) => !(name in OVERRIDE_REGISTRY))
      .map((name) => {
        const where = reads.filter((r) => r.varName === name).map((r) => rel(r.file));
        return `${name} (read in ${where.join(", ")})`;
      });

    expect(
      unregistered,
      `Unregistered mock-redirect override(s).\n\n` +
        `A *_BASE_URL / *_MOCK_HOST / *_MOCK_PORT var reroutes an authenticated\n` +
        `outbound call. Add it to OVERRIDE_REGISTRY in this file as either\n` +
        `  { gatedBy: "PINCHY_INSECURE_MAIL_MOCK" }  — and route the read through\n` +
        `    resolveInsecureMockBaseUrl(), or name the flag in the reading file, or\n` +
        `  { exempt: "<why this one needs no flag>" }\n`
    ).toEqual([]);
  });

  it("keeps no registry entry whose var has disappeared from the source", () => {
    // A verdict must not outlive its evidence: a stale entry silently
    // pre-approves a var somebody may reintroduce later, unexamined.
    const seen = new Set(reads.map((r) => r.varName));
    const orphans = Object.keys(OVERRIDE_REGISTRY).filter((name) => !seen.has(name));

    expect(
      orphans,
      "Registry entries for override vars no source file reads any more — delete them."
    ).toEqual([]);
  });

  it("gates every flag-required override at the place it is read", () => {
    const ungated: string[] = [];

    for (const read of reads) {
      const verdict = OVERRIDE_REGISTRY[read.varName];
      if (!verdict || "exempt" in verdict) continue;
      // A resolver enforces the flag itself, so the reading file need not.
      if (read.viaResolver) continue;
      // A bare read is acceptable only where the same file applies the flag
      // inline, as imap-adapter.ts does.
      const src = readFileSync(read.file, "utf8");
      if (src.includes(verdict.gatedBy)) continue;
      ungated.push(`${read.varName} in ${rel(read.file)} (expected ${verdict.gatedBy})`);
    }

    expect(
      ungated,
      `Override read without its opt-in flag.\n\n` +
        `Route it through ${FLAG_ENFORCING_RESOLVERS.join("() / ")}(), or apply the\n` +
        `flag inline in the same file the way imap-adapter.ts does.\n`
    ).toEqual([]);
  });

  it("covers both halves of the deployment — the web app and the plugins", () => {
    // The seam has two sides and the first fix only closed one. Pinchy holds
    // the client secret and the refresh tokens; OpenClaw holds an access token.
    // A guard that scanned only one tree would have called that fix complete.
    const scannedWeb = reads.some((r) => r.file.startsWith(WEB_SRC));
    const scannedPlugins = reads.some((r) => r.file.startsWith(PLUGINS_DIR));
    expect({ scannedWeb, scannedPlugins }).toEqual({ scannedWeb: true, scannedPlugins: true });
  });
});
