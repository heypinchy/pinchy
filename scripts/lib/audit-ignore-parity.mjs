/**
 * Drift guard for the two places this repo accepts a vulnerability.
 *
 * There are two scanners and they read different files:
 *
 *   1. `osv-scanner --config=./osv-scanner.toml` — the CI `vuln-scan` job.
 *      Acceptances live in `[[IgnoredVulns]]` blocks, each carrying a `reason`
 *      and (usually) an `ignoreUntil` date that forces a re-triage.
 *   2. `pnpm audit --audit-level=high --prod` — the gate `scripts/release.mjs`
 *      runs before a tag is cut. It does NOT read `osv-scanner.toml`. Its
 *      acceptances live in `pnpm.auditConfig.ignoreGhsas` in the root
 *      package.json: a bare array of ids, with no reason field and no expiry.
 *
 * Until v0.9.0 only the first one had been told about GHSA-mh99-v99m-4gvg, so
 * the release could not be cut over an advisory the repo had triaged and
 * accepted months earlier (#914). The acceptance sat on record in a place the
 * release path never consults. That is what pinchy#993 fixed, by hand, with a
 * comment in osv-scanner.toml asking the next person to keep the two in
 * lockstep.
 *
 * This file is that comment, enforced. The property guarded is not "an id is
 * written down twice" — it is that **the pnpm-side silence never outlives the
 * osv-side rationale**, in either of the two ways it can:
 *
 *   - An id in `ignoreGhsas` with no `[[IgnoredVulns]]` entry is an
 *     unexplained, permanent silencer of the *release* gate on *production*
 *     dependencies. `ignoreGhsas` has no `reason` field, so nothing about that
 *     entry says what was accepted or why — and unlike a red CI job, nobody
 *     ever sees it, because its whole effect is that nothing is printed.
 *   - An id in `ignoreGhsas` whose osv entry has EXPIRED is worse than either
 *     config alone. osv-scanner goes red on the expiry date and forces the
 *     re-triage; `pnpm audit` cannot, because pnpm has no `ignoreUntil` and
 *     never will notice. So on that date the two configs diverge by
 *     construction: CI re-opens the question while the release path stays
 *     silent about it forever. Expiry is the one property the two files cannot
 *     express symmetrically, which is exactly why it needs a checker rather
 *     than a convention.
 *
 * The check is deliberately ONE-DIRECTIONAL: every `ignoreGhsas` id needs an
 * osv entry, never the reverse. Most `[[IgnoredVulns]]` entries here are things
 * `pnpm audit --prod` at the repo root cannot see anyway — the braces one is a
 * devDependency, and anything accepted in `docs/pnpm-lock.yaml` (a separate,
 * non-workspace lockfile; the astro advisories, until #851) is out of reach. Mirroring those into `ignoreGhsas` would
 * silence a scanner about findings it never reports, which is a lie in the
 * config rather than a safety property.
 *
 * Read-side sibling of the node-version-pin / format-gate / ci-path-filter
 * guards (see AGENTS.md).
 */

/**
 * Extract the `[[IgnoredVulns]]` entries from an osv-scanner.toml.
 *
 * Hand-rolled rather than pulled from a TOML library on purpose: the repo has
 * no TOML dependency at the root, and this reads exactly one table-array whose
 * shape is fixed by osv-scanner's own schema (`id`, `reason`, `ignoreUntil`).
 *
 * A header or entry it cannot read throws rather than being skipped: an
 * acceptance osv-scanner honours but this parser drops is invisible to every
 * rule below, which is a silent green, not a parse error.
 *
 * Known limits, so nobody reads a green check as more than it is: values are
 * matched as single-line basic strings / bare date literals, which is how
 * osv-scanner documents them and how every entry in this repo is written. A
 * multi-line (`"""`) reason or a quoted date would parse as absent, and the
 * guard would then complain about a field that is really there — loud and
 * wrong, never silent and wrong.
 *
 * @param {string} toml
 * @returns {Array<{ id: string, reason: string | null, ignoreUntil: string | null }>}
 */
export function parseOsvIgnoredVulns(toml) {
  const text = String(toml);

  // A header the split below cannot read must not be skipped: osv-scanner
  // still honours the entry, and every rule in this file would be blind to it.
  // TOML allows a quoted key (`[["IgnoredVulns"]]`); nothing here writes one,
  // so refuse it loudly rather than learn a second spelling.
  for (const line of text.split("\n")) {
    if (/^\s*\[\[[^\]]*IgnoredVulns/.test(line) && !HEADER.test(line)) {
      throw new Error(
        `osv-scanner.toml: cannot read the table header ${line.trim()}. ` +
          `Write it as [[IgnoredVulns]] so the acceptance parity guard can see the entry.`,
      );
    }
  }

  const entries = [];
  // Split on the table-array header, keeping only what follows each one. A
  // later `[SomethingElse]` header ends the entry. The header may carry inner
  // whitespace and a trailing comment — both valid TOML, both honoured by
  // osv-scanner, and both once skipped here along with their whole entry.
  const blocks = text.split(new RegExp(HEADER.source, "m")).slice(1);

  for (const block of blocks) {
    const body = block.split(/^\s*\[/m)[0];
    const id = matchValue(body, "id");
    if (!id) {
      throw new Error(
        `osv-scanner.toml: an [[IgnoredVulns]] entry has no readable id ` +
          `(expected id = "…" on its own line): ${JSON.stringify(body.trim().slice(0, 120))}`,
      );
    }
    entries.push({
      id,
      reason: matchValue(body, "reason"),
      ignoreUntil: matchDate(body, "ignoreUntil"),
    });
  }

  return entries;
}

const HEADER = /^[ \t]*\[\[[ \t]*IgnoredVulns[ \t]*\]\][ \t]*(?:#.*)?$/;

/**
 * @param {string} body
 * @param {string} key
 * @returns {string | null}
 */
function matchValue(body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

/**
 * @param {string} body
 * @param {string} key
 * @returns {string | null}
 */
function matchDate(body, key) {
  const match = body.match(
    new RegExp(`^\\s*${key}\\s*=\\s*(\\d{4}-\\d{2}-\\d{2})\\s*$`, "m"),
  );
  return match ? match[1] : null;
}

/**
 * Read the pnpm-side acceptances out of a parsed root package.json.
 *
 * Returns `[]` when the key is absent — that is the honest reading (nothing is
 * ignored), and it is the state this repo was in before pinchy#993.
 *
 * @param {unknown} pkg
 * @returns {string[]}
 */
export function parseAuditIgnoreGhsas(pkg) {
  const list = /** @type {any} */ (pkg)?.pnpm?.auditConfig?.ignoreGhsas ?? [];
  if (!Array.isArray(list)) {
    throw new TypeError(
      `pnpm.auditConfig.ignoreGhsas must be an array of GHSA ids, got ${JSON.stringify(list)}`,
    );
  }
  return list.map(String);
}

/**
 * Check that every pnpm-side acceptance is backed by a live osv-side one.
 *
 * `today` is injected so the expiry rule is testable. The repo-level test
 * passes the real date on purpose: the guard going red on the expiry date is
 * the mechanism, not an accident — it is how `ignoreGhsas`, which has no
 * expiry of its own, inherits the one written next to the rationale.
 *
 * @param {{
 *   osvEntries: Array<{ id: string, reason: string | null, ignoreUntil: string | null }>,
 *   ghsaIgnores: string[],
 *   today: string,
 * }} input
 * @returns {string[]} one actionable message per problem, empty when clean
 */
export function validateAuditIgnoreParity({ osvEntries, ghsaIgnores, today }) {
  const errors = [];
  const byId = new Map(osvEntries.map((entry) => [entry.id, entry]));
  const seen = new Set();

  for (const id of ghsaIgnores) {
    if (seen.has(id)) {
      errors.push(
        `pnpm.auditConfig.ignoreGhsas lists ${id} twice — remove the duplicate.`,
      );
      continue;
    }
    seen.add(id);

    // pnpm matches this list against GitHub advisory ids only. A CVE, OSV or
    // MAL id here matches nothing, so it reads as an acceptance while silencing
    // exactly zero findings — and the release gate still fails, with the
    // config appearing to say otherwise.
    if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(id)) {
      errors.push(
        `pnpm.auditConfig.ignoreGhsas entry "${id}" is not a GHSA id. ` +
          `pnpm audit matches GitHub advisory ids only, so this entry silences nothing.`,
      );
      continue;
    }

    const entry = byId.get(id);
    if (!entry) {
      errors.push(
        `${id} is ignored by pnpm audit (pnpm.auditConfig.ignoreGhsas) but has no ` +
          `[[IgnoredVulns]] entry in osv-scanner.toml. ignoreGhsas carries no reason ` +
          `and no expiry, so on its own it is an unexplained, permanent silencing of ` +
          `the release gate. Add the entry with a reason and an ignoreUntil, or drop ` +
          `the id from ignoreGhsas.`,
      );
      continue;
    }

    if (!entry.reason || !entry.reason.trim()) {
      errors.push(
        `${id} has an [[IgnoredVulns]] entry in osv-scanner.toml with no reason. ` +
          `The reason is the only machine-readable record of what was accepted — ` +
          `osv-scanner prints it, the TOML comments above it are not printed anywhere.`,
      );
    }

    if (!entry.ignoreUntil) {
      errors.push(
        `${id} is ignored by pnpm audit but its osv-scanner.toml entry has no ignoreUntil. ` +
          `pnpm has no expiry mechanism, so without one on the osv side the acceptance ` +
          `is unbounded on the release path. Add ignoreUntil = YYYY-MM-DD.`,
      );
    } else if (entry.ignoreUntil <= today) {
      errors.push(
        `${id} expired on ${entry.ignoreUntil} (today is ${today}). osv-scanner now ` +
          `reports it again, but pnpm audit still ignores it — pnpm has no expiry, so ` +
          `the release gate stays silent unless someone acts. Re-triage: either renew ` +
          `ignoreUntil with a fresh reason, or drop the id from BOTH osv-scanner.toml ` +
          `and pnpm.auditConfig.ignoreGhsas.`,
      );
    }
  }

  return errors;
}

/**
 * Today as `YYYY-MM-DD`, in UTC.
 *
 * String comparison against a TOML date literal is exact for this format, so
 * the guard never needs to construct a Date from the config value.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ─── The reason names every route it accepts ─────────────────────────────────

/**
 * Read a pnpm v9 lockfile into the two facts the route check needs: which
 * packages an importer declares directly, and, for every package, which
 * packages depend on it.
 *
 * Hand-rolled for the same reason as the TOML parser: no YAML dependency at the
 * root, and the lockfile's shape is fixed by pnpm. It reads the `importers:`
 * and `snapshots:` sections only, by indentation. A file without a
 * `snapshots:` section throws — an empty graph would make every reason look
 * complete.
 *
 * @param {string} text
 * @returns {{ direct: Set<string>, dependents: Map<string, Set<string>> }}
 */
export function parseLockfileGraph(text) {
  const lines = String(text).split("\n");
  const direct = new Set();
  const dependents = new Map();
  let section = null;
  let sawSnapshots = false;
  let inDeps = false;
  let parent = null;

  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      if (section === "snapshots") sawSnapshots = true;
      inDeps = false;
      continue;
    }
    if (!line.trim()) continue;

    if (section === "importers") {
      // "    dependencies:" opens a block; "      name:" is a declared dep.
      if (/^ {4}\S/.test(line)) {
        inDeps =
          /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(
            line,
          );
      } else if (inDeps && /^ {6}\S/.test(line)) {
        direct.add(unquote(line.trim().replace(/:\s*$/, "")));
      }
    } else if (section === "snapshots") {
      if (/^ {2}\S/.test(line)) {
        parent = packageName(unquote(line.trim().replace(/:\s*(\{\})?$/, "")));
        inDeps = false;
      } else if (/^ {4}\S/.test(line)) {
        inDeps = /^ {4}(dependencies|optionalDependencies):\s*$/.test(line);
      } else if (inDeps && parent && /^ {6}\S/.test(line)) {
        const child = unquote(line.trim().replace(/:\s.*$/, ""));
        if (!dependents.has(child)) dependents.set(child, new Set());
        dependents.get(child).add(parent);
      }
    }
  }

  if (!sawSnapshots) {
    throw new Error(
      "not a pnpm v9 lockfile: no snapshots: section, so no dependency edge can be read",
    );
  }
  return { direct, dependents };
}

/** @param {string} s */
function unquote(s) {
  return s.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
}

/**
 * `@scope/name@1.2.3(peer@4)` → `@scope/name`.
 *
 * @param {string} key
 */
function packageName(key) {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return at === -1 ? key : key.slice(0, at);
}

/**
 * The lockfiles CI's vuln-scan job hands osv-scanner, read from ci.yml so the
 * route check reads exactly what the scanner reads.
 *
 * @param {string} ciYaml
 * @returns {string[]}
 */
export function scannedLockfiles(ciYaml) {
  return [...String(ciYaml).matchAll(/--lockfile=\.\/(\S+)/g)].map((m) => m[1]);
}

/**
 * Check that every acceptance's reason names each package that pulls the
 * vulnerable one in.
 *
 * AGENTS.md: "an acceptance that does not name a path it accepts is not an
 * acceptance of that path". The reason is the only record osv-scanner prints,
 * so that is where the routes have to be — and they are derived from the
 * lockfiles rather than listed per advisory, so a NEW route (a second package
 * starting to depend on braces, say) turns this red until the reason says why
 * that path is acceptable too.
 *
 * Convention this relies on, and enforces: a reason begins with the affected
 * package's name (`braces <=3.0.3, …`, `astro — …`). That is how every entry
 * here is written, and it is the only link from an advisory id to a lockfile
 * package that needs no network.
 *
 * A package an importer declares directly is accepted through its own
 * declaration, so only transitive packages need their dependents named — the
 * immediate ones, which is the edge that decides whether the package is
 * installed at all.
 *
 * @param {{
 *   osvEntries: Array<{ id: string, reason: string | null }>,
 *   lockfiles: Array<{ path: string, text: string }>,
 * }} input
 * @returns {string[]}
 */
export function findUnnamedRoutes({ osvEntries, lockfiles }) {
  const graphs = lockfiles.map(({ path, text }) => ({
    path,
    ...parseLockfileGraph(text),
  }));
  const errors = [];

  for (const entry of osvEntries) {
    const reason = entry.reason ?? "";
    const pkg = reason.match(
      /^\s*(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?)/i,
    )?.[1];
    const hits = pkg
      ? graphs.filter((g) => g.direct.has(pkg) || g.dependents.has(pkg))
      : [];

    if (hits.length === 0) {
      errors.push(
        `${entry.id}: the reason must begin with the affected package's name, and ` +
          `that package must resolve in a lockfile vuln-scan scans ` +
          `(${graphs.map((g) => g.path).join(", ")}). Got ${JSON.stringify(reason.slice(0, 60))}.`,
      );
      continue;
    }

    for (const g of hits) {
      if (g.direct.has(pkg)) continue;
      const missing = [...(g.dependents.get(pkg) ?? [])]
        .filter((dep) => !namesPackage(reason, dep))
        .sort();
      if (missing.length > 0) {
        errors.push(
          `${entry.id}: ${pkg} is pulled in by ${missing.join(", ")} in ${g.path}, ` +
            `but the reason does not name ${missing.length === 1 ? "that route" : "those routes"}. ` +
            `Say why each path is acceptable, or the acceptance does not cover it.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Whole-name match: `argparse` is named by "argparse@1" or "> argparse," but
 * not by "argparse-ng".
 *
 * @param {string} text
 * @param {string} name
 */
function namesPackage(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@/.-])${escaped}(?![\\w/-])`).test(text);
}

// ─── The release gate's own command runs in CI ───────────────────────────────

/**
 * The ci.yml jobs with a step that runs exactly `command` — as a one-line
 * `run:` or as a line of a `run: |` block. Exact on purpose: `pnpm audit
 * --prod` is not the gate `pnpm audit --audit-level=high --prod` is, and a
 * trailing `|| true` would make it no gate at all.
 *
 * @param {string} ciYaml
 * @param {string} command
 * @returns {string[]}
 */
export function findAuditJobs(ciYaml, command) {
  const jobs = [];
  let current = null;
  for (const line of String(ciYaml).split("\n")) {
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      current = job[1];
      continue;
    }
    const body = line
      .trim()
      .replace(/^-\s*/, "")
      .replace(/^run:\s*/, "");
    if (current && body === command && !jobs.includes(current)) {
      jobs.push(current);
    }
  }
  return jobs;
}
