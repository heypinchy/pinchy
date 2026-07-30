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
 * `pnpm audit --prod` at the repo root cannot see anyway — the astro advisories
 * live in `docs/pnpm-lock.yaml` (a separate, non-workspace lockfile) and the
 * openclaw one is a devDependency. Mirroring those into `ignoreGhsas` would
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
  const entries = [];
  // Split on the table-array header, keeping only what follows each one. A
  // later `[SomethingElse]` header ends the entry.
  const blocks = String(toml)
    .split(/^\s*\[\[IgnoredVulns\]\]\s*$/m)
    .slice(1);

  for (const block of blocks) {
    const body = block.split(/^\s*\[/m)[0];
    const id = matchValue(body, "id");
    if (!id) continue;
    entries.push({
      id,
      reason: matchValue(body, "reason"),
      ignoreUntil: matchDate(body, "ignoreUntil"),
    });
  }

  return entries;
}

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
