/**
 * Every env var the docs tell an operator about must reach the Pinchy
 * container (#1361).
 *
 * Compose reads `.env` only to substitute `${VAR}` inside the Compose file. A
 * variable the file never names in the service's `environment:` list stays on
 * the host: the container never sees it, and the app falls back to its default
 * without a word. v0.10.0 shipped exactly that for `PINCHY_KB_OCR`. The upgrade
 * guide told operators to set `PINCHY_KB_OCR=off` in `.env` before upgrading so
 * scans would not leave the house, the app read it correctly, and the
 * production `docker-compose.yml` never forwarded it. So the switch an operator
 * set to keep scans in-house did nothing, and nothing could tell them. Five other
 * documented switches had the same gap, one of them
 * `PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS`. A guard that does nothing when set
 * fails open.
 *
 * `env-var-reference.mjs` already compares the Compose file with the reference
 * page, in both directions. It could not catch this: it starts from what Compose
 * expands, and a variable Compose never names is invisible from there. This
 * guard starts from the other end, from what the app reads:
 *
 *   1. every literal `process.env.NAME` / `process.env["NAME"]` in
 *      `packages/web/src` production code,
 *   2. narrowed to the names any docs page mentions, since a name the docs
 *      present is one an operator will set,
 *   3. must appear in the `pinchy` service's `environment:` list.
 *
 * Known limits:
 * - A dynamic key (`process.env[name]`, `process.env[CONST]`) is not read.
 *   `PINCHY_TRUSTED_PROXIES` and the provider `*_BASE_URL` overrides are read
 *   that way.
 * - Plugins run in the openclaw container. None of them reads an operator
 *   setting the docs name today, so only the pinchy service is checked.
 * - "The docs mention it" is a heuristic. A page that names an internal
 *   variable in passing makes the guard ask for it. The answer is then an
 *   exemption with a written reason, not a looser match.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Read by the app, mentioned by the docs, and deliberately left out of the
 * pinchy `environment:` list. Each entry states why. `checkExemptions` fails
 * once an entry stops being true.
 */
export const NOT_FORWARDED_ON_PURPOSE = {
  KB_EMBEDDING_THREADS:
    "documented as an override-file setting only (customizing-deployment.mdx): " +
    "the default is derived from the container's CPU limit, and a `${…:-}` " +
    "pass-through would invite setting it in .env next to a mismatched DB_CPUS",
  NODE_ENV:
    "set by the image itself (`production` in Dockerfile.pinchy); the docs " +
    "mention it to explain behaviour, not as something an operator sets",
};

const READ =
  /process\.env(?:\.([A-Z_][A-Z0-9_]*)\b|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])/g;

/**
 * @param {string} source a TypeScript source file
 * @returns {Set<string>} names read through a literal key
 */
export function extractEnvReads(source) {
  const names = new Set();
  for (const [, dot, bracket] of source.matchAll(READ))
    names.add(dot ?? bracket);
  return names;
}

/**
 * The names in one service's `environment:` list, in both list spellings:
 * `- NAME=value` and the pass-through `- NAME`.
 *
 * Throws instead of returning an empty set when it cannot read the block. An
 * empty set would report every documented variable as missing, and a reader
 * that throws away part of the input would pass on whatever it failed to read.
 *
 * @param {string} composeSource
 * @param {string} service
 * @returns {Set<string>}
 */
export function extractServiceEnvironment(composeSource, service) {
  const lines = composeSource.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^  ${service}:\\s*$`).test(l),
  );
  if (start === -1) {
    throw new Error(`docker-compose.yml: no \`${service}:\` service found`);
  }
  const names = new Set();
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 2) break; // the next service
    if (indent === 4) {
      inEnvironment = /^ {4}environment:\s*$/.test(line);
      continue;
    }
    if (!inEnvironment) continue;
    const entry = /^\s*-\s*([A-Z_][A-Z0-9_]*)\s*(=|$)/.exec(line);
    if (!entry) {
      throw new Error(
        `docker-compose.yml: cannot read this line of \`${service}.environment\`: ` +
          `${line.trim()}\nOnly the list form (\`- NAME=value\` / \`- NAME\`) is read.`,
      );
    }
    names.add(entry[1]);
  }
  if (names.size === 0) {
    throw new Error(
      `docker-compose.yml: \`${service}\` has no \`environment:\` entries`,
    );
  }
  return names;
}

/** Whole-name match: `PINCHY_KB` does not count as `PINCHY_KB_OCR`. */
export function mentionedIn(docs, name) {
  return new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(docs);
}

/**
 * @param {{reads: Set<string>, docs: string, forwarded: Set<string>,
 *          exemptions: Record<string, string>}} input
 * @returns {string[]} problems (empty = ok)
 */
export function findUnforwardedOperatorSettings({
  reads,
  docs,
  forwarded,
  exemptions,
}) {
  return [...reads]
    .filter((name) => mentionedIn(docs, name))
    .filter((name) => !forwarded.has(name) && !(name in exemptions))
    .sort()
    .map(
      (name) =>
        `${name}: the web app reads it and the docs name it, but the pinchy ` +
        `service in docker-compose.yml never forwards it, so setting it in ` +
        `.env does nothing. Add \`- ${name}=\${${name}:-}\` to its ` +
        `environment list (and a row to reference/environment-variables.mdx), ` +
        `or add it to NOT_FORWARDED_ON_PURPOSE with the reason.`,
    );
}

/**
 * An exemption is a claim about today's tree, so it fails once the claim no
 * longer holds.
 *
 * @param {{reads: Set<string>, docs: string, forwarded: Set<string>,
 *          exemptions: Record<string, string>}} input
 * @returns {string[]} problems (empty = ok)
 */
export function checkExemptions({ reads, docs, forwarded, exemptions }) {
  const problems = [];
  for (const [name, reason] of Object.entries(exemptions)) {
    if (reason.trim().length < 30) {
      problems.push(`NOT_FORWARDED_ON_PURPOSE["${name}"] needs a real reason`);
    }
    if (forwarded.has(name)) {
      problems.push(
        `NOT_FORWARDED_ON_PURPOSE lists ${name}, but docker-compose.yml now forwards it. Drop the entry.`,
      );
    } else if (!reads.has(name)) {
      problems.push(
        `NOT_FORWARDED_ON_PURPOSE lists ${name}, but packages/web/src no longer reads it. Drop the entry.`,
      );
    } else if (!mentionedIn(docs, name)) {
      problems.push(
        `NOT_FORWARDED_ON_PURPOSE lists ${name}, but the docs no longer name it. Drop the entry.`,
      );
    }
  }
  return problems;
}

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isProductionSource = (root) => (path) => {
  const rel = relative(root, path);
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.test(-d)?\.(ts|tsx)$/.test(rel) &&
    !rel.split("/").includes("__tests__") &&
    !rel.split("/").includes("test-helpers")
  );
};

/** @param {string} repoRoot */
export function readWebEnvReads(repoRoot) {
  const src = join(repoRoot, "packages/web/src");
  const names = new Set();
  for (const file of walk(src, isProductionSource(src))) {
    for (const name of extractEnvReads(readFileSync(file, "utf8")))
      names.add(name);
  }
  return names;
}

/** @param {string} repoRoot */
export function readDocsCorpus(repoRoot) {
  return walk(join(repoRoot, "docs/src/content/docs"), (p) => /\.mdx?$/.test(p))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}
