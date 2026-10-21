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

import { splitWorkflowTextIntoJobs } from "./workflow-jobs.mjs";

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
  // CRLF is a checkout setting, not a different file.
  const text = String(toml).replace(/\r\n?/g, "\n");

  // A spelling the split below cannot read must not be skipped: osv-scanner
  // still honours the entry, and every rule in this file would be blind to it.
  // TOML allows a quoted key (`[["IgnoredVulns"]]`) and an inline array
  // (`IgnoredVulns = [{ … }]`), and osv-scanner's TOML decoder matches keys
  // case-insensitively (`[[ignoredvulns]]`). Nothing here writes any of them,
  // so refuse them loudly rather than learn a second spelling.
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[[^\]]*IgnoredVulns/i.test(line);
    const inline = /^\s*["']?IgnoredVulns["']?\s*=/i.test(line);
    if ((header && !HEADER.test(line)) || inline) {
      throw new Error(
        `osv-scanner.toml: cannot read ${line.trim()}. ` +
          `Write each entry under its own [[IgnoredVulns]] header so the acceptance parity guard can see it.`,
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
 * Read a pnpm v9 lockfile into a versioned dependency graph.
 *
 * Nodes are snapshot keys (`name@version(peers)`), so two versions of one
 * package are two nodes: argparse@1 (which pulls sprintf-js) and argparse@2
 * (which does not) must not be confused. An npm alias
 * (`string-width-cjs: string-width@4.2.3`) resolves to the real package's
 * node. An edge to a package the parent declares as a PEER is dropped: a peer
 * is the consumer's own pick (Starlight → astro), not a second way in.
 *
 * Hand-rolled for the same reason as the TOML parser: no YAML dependency at the
 * root, and the lockfile's shape is fixed by pnpm. It reads the `importers:`,
 * `packages:` (peers only) and `snapshots:` sections, by indentation. A file
 * without a `snapshots:` section throws — an empty graph would make every
 * reason look complete.
 *
 * @param {string} text
 * @returns {{
 *   roots: Set<string>,
 *   parents: Map<string, Set<string>>,
 *   nodes: Set<string>,
 * }} `roots` are the nodes an importer declares directly; `parents` maps a
 *   node to the nodes that depend on it (peer edges excluded).
 */
export function parseLockfileGraph(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const roots = new Set();
  const nodes = new Set();
  const peers = new Map();
  /** @type {Array<[string, string]>} parent node → child node */
  const edges = [];
  let section = null;
  let sawSnapshots = false;
  let inDeps = false;
  let current = null;
  let depName = null;

  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      if (section === "snapshots") sawSnapshots = true;
      inDeps = false;
      current = null;
      continue;
    }
    if (!line.trim()) continue;

    if (section === "importers") {
      // "    dependencies:" opens a block; "      name:" names a declared dep
      // and "        version: …" says which node it resolved to.
      if (/^ {4}\S/.test(line)) {
        inDeps =
          /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(
            line,
          );
      } else if (inDeps && /^ {6}\S/.test(line)) {
        depName = keyOf(line);
      } else if (inDeps && depName && /^ {8}version:\s/.test(line)) {
        const node = resolveRef(depName, valueOf(line));
        if (node) roots.add(node);
      }
    } else if (section === "packages") {
      if (/^ {2}\S/.test(line)) {
        current = keyOf(line);
        inDeps = false;
      } else if (/^ {4}\S/.test(line)) {
        inDeps = /^ {4}peerDependencies:\s*$/.test(line);
      } else if (inDeps && current && /^ {6}\S/.test(line)) {
        if (!peers.has(current)) peers.set(current, new Set());
        peers.get(current).add(keyOf(line));
      }
    } else if (section === "snapshots") {
      if (/^ {2}\S/.test(line)) {
        current = keyOf(line);
        nodes.add(current);
        inDeps = false;
      } else if (/^ {4}\S/.test(line)) {
        inDeps = /^ {4}(dependencies|optionalDependencies):\s*$/.test(line);
      } else if (inDeps && current && /^ {6}\S/.test(line)) {
        const child = resolveRef(keyOf(line), valueOf(line));
        if (child) edges.push([current, child]);
      }
    }
  }

  if (!sawSnapshots) {
    throw new Error(
      "not a pnpm v9 lockfile: no snapshots: section, so no dependency edge can be read",
    );
  }

  const parents = new Map();
  for (const [parent, child] of edges) {
    const declaredPeers = peers.get(withoutPeers(parent));
    if (declaredPeers?.has(packageName(child))) continue;
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child).add(parent);
  }
  return { roots, parents, nodes };
}

/** `      'name': value` → `name` */
function keyOf(line) {
  return unquote(
    line
      .trim()
      .replace(/:\s.*$/, "")
      .replace(/:\s*(\{\})?$/, ""),
  );
}

/** `      name: value` → `value` */
function valueOf(line) {
  return unquote(
    line
      .trim()
      .replace(/^('[^']*'|"[^"]*"|[^:]+):\s*/, "")
      .trim(),
  );
}

/**
 * A dependency reference to the snapshot key it points at. `link:` is a
 * workspace package, which has no snapshot and is read as an importer instead.
 *
 * @param {string} name
 * @param {string} ref `1.2.3(peer@4)` or, for an alias, `real@1.2.3`
 * @returns {string | null}
 */
function resolveRef(name, ref) {
  if (!ref || ref.startsWith("link:")) return null;
  const bare = withoutPeers(ref);
  const isAlias = bare.indexOf("@", bare.startsWith("@") ? 1 : 0) > 0;
  return isAlias ? ref : `${name}@${ref}`;
}

/** @param {string} s */
function unquote(s) {
  return s.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
}

/** `@scope/name@1.2.3(peer@4)` → `@scope/name@1.2.3` */
function withoutPeers(key) {
  const paren = key.indexOf("(");
  return paren === -1 ? key : key.slice(0, paren);
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

/** `@scope/name@1.2.3(peer@4)` → `1.2.3` */
function packageVersion(key) {
  return withoutPeers(key).slice(packageName(key).length + 1);
}

/**
 * The lockfiles CI's vuln-scan job hands osv-scanner, read from that job's own
 * body so the route check reads exactly what the scanner reads.
 *
 * @param {string} ciYaml
 * @returns {string[]}
 */
export function scannedLockfiles(ciYaml) {
  const vulnScan = splitWorkflowTextIntoJobs(String(ciYaml)).find(
    (job) => job.jobName === "vuln-scan",
  );
  if (!vulnScan) throw new Error("ci.yml defines no vuln-scan job");
  return [...vulnScan.body.matchAll(/--lockfile=\.\/(\S+)/g)].map((m) => m[1]);
}

/**
 * The start of a reason: the affected package, then the versions the
 * acceptance claims are affected — an exact version or up to two comparators.
 * `braces <=3.0.3, …`, `katex >=0.16.0 <0.18.2 …`.
 */
const REASON_HEAD =
  /^\s*(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?)\s+((?:[<>]=?|=)?\d+\.\d+\.\d+(?:\s+(?:[<>]=?)\d+\.\d+\.\d+)?)(?=[\s,;:]|$)/i;

/**
 * Check that every acceptance's reason names each route that pulls the
 * vulnerable package in.
 *
 * AGENTS.md: "an acceptance that does not name a path it accepts is not an
 * acceptance of that path". The reason is the only record osv-scanner prints,
 * so that is where the routes have to be — and they are derived from the
 * lockfiles rather than listed per advisory, so a NEW route turns this red
 * until the reason says why that path is acceptable too.
 *
 * Convention this relies on, and enforces: a reason begins with the affected
 * package and the versions it claims are affected (`braces <=3.0.3, …`). The
 * range is what ties the name to the advisory without a network call: a reason
 * that opens with some other package ("mammoth pulls sprintf-js in …") has no
 * range, and one whose range matches no resolved version describes a package
 * the lockfile does not contain in an affected version. Nothing offline can
 * prove the range is the advisory's own; it can prove it is a claim about the
 * package the lockfile actually has.
 *
 * A route is named when the reason names, for every affected version:
 *
 *   - each package that depends on it directly (the edge that installs it), and
 *   - each importer-declared dependency it is reached through (the edge that
 *     decides whether it is a runtime or a dev dependency).
 *
 * The second is what catches a new consumer arriving through an intermediate
 * the reason already names — a runtime package that starts using fast-glob, or
 * js-yaml@3 pulling argparse@1.
 *
 * @param {{
 *   osvEntries: Array<{ id: string, reason: string | null }>,
 *   lockfiles: Array<{ path: string, text: string }>,
 * }} input
 * @returns {{ errors: string[], checked: string[] }} `checked` lists the ids
 *   whose routes were actually evaluated, so a caller can assert the rule ran.
 */
export function findUnnamedRoutes({ osvEntries, lockfiles }) {
  const graphs = lockfiles.map(({ path, text }) => ({
    path,
    ...parseLockfileGraph(text),
  }));
  const where = graphs.map((g) => g.path).join(", ");
  const errors = [];
  const checked = [];

  for (const entry of osvEntries) {
    const reason = entry.reason ?? "";
    const head = reason.match(REASON_HEAD);
    if (!head) {
      errors.push(
        `${entry.id}: the reason must begin with the affected package and the ` +
          `versions it claims are affected (e.g. "braces <=3.0.3, …"). ` +
          `Got ${JSON.stringify(reason.slice(0, 60))}.`,
      );
      continue;
    }
    const [, pkg, range] = head;

    const present = graphs.filter((g) =>
      [...g.nodes].some((n) => packageName(n) === pkg),
    );
    if (present.length === 0) {
      errors.push(
        `${entry.id}: ${pkg} is in no lockfile vuln-scan scans (${where}). ` +
          `The acceptance is stale — osv-scanner reports it as UNUSED. Remove it.`,
      );
      continue;
    }

    const affected = present.flatMap((g) =>
      [...g.nodes]
        .filter(
          (n) => packageName(n) === pkg && satisfies(packageVersion(n), range),
        )
        .map((node) => ({ g, node })),
    );
    if (affected.length === 0) {
      const versions = present
        .flatMap((g) => [...g.nodes].filter((n) => packageName(n) === pkg))
        .map(packageVersion);
      errors.push(
        `${entry.id}: the reason claims ${pkg} ${range}, but the lockfiles resolve ` +
          `${pkg} to ${[...new Set(versions)].join(", ")}. Either the range is not ` +
          `the advisory's, or the acceptance is stale.`,
      );
      continue;
    }
    checked.push(entry.id);

    for (const g of present) {
      const required = new Set();
      for (const { node } of affected.filter((a) => a.g === g)) {
        for (const p of g.parents.get(node) ?? []) required.add(packageName(p));
        for (const root of rootsReaching(g, node)) required.add(root);
      }
      required.delete(pkg);
      const missing = [...required]
        .filter((name) => !namesPackage(reason, name))
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

  return { errors, checked };
}

/**
 * The names of the importer-declared dependencies `node` is reached through,
 * itself included when an importer declares it.
 *
 * @param {{ roots: Set<string>, parents: Map<string, Set<string>> }} g
 * @param {string} node
 */
function rootsReaching(g, node) {
  const found = new Set();
  const seen = new Set([node]);
  const queue = [node];
  while (queue.length > 0) {
    const n = queue.shift();
    if (g.roots.has(n)) found.add(packageName(n));
    for (const p of g.parents.get(n) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return found;
}

/**
 * `1.0.3` against `<=1.1.3`, `>=1.0.0 <2.0.0` or an exact `1.0.3`. Prerelease
 * tags are ignored: a lockfile pin like `1.0.0-rc.1` is compared as `1.0.0`.
 *
 * @param {string} version
 * @param {string} range
 */
export function satisfies(version, range) {
  const v = triple(version);
  if (!v) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const [, op = "=", want] = comparator.match(/^([<>]=?|=)?(.+)$/) ?? [];
      const w = triple(want);
      if (!w) return false;
      const c = compare(v, w);
      return {
        "<": c < 0,
        "<=": c <= 0,
        ">": c > 0,
        ">=": c >= 0,
        "=": c === 0,
      }[op];
    });
}

/** @param {string | undefined} s */
function triple(s) {
  const m = s?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
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
 * What turns a failing step green without changing the command it runs.
 * Same list the issue-triage wiring guard rejects, plus `set +e` and a job
 * that never runs.
 */
const DEFUSERS = [
  [/^\s*continue-on-error:\s*(true|\$\{\{)/m, "continue-on-error"],
  [/\|\|\s*(true|:)\s*$/m, "|| true"],
  [/^\s*set \+e\s*$/m, "set +e"],
  [/^\s*exit 0\s*$/m, "exit 0"],
  [/^ {4}if:\s*false\s*$/m, "if: false"],
];

/**
 * The ci.yml jobs with a step that runs exactly `command` — as a one-line
 * `run:` or as a line of a `run: |` block — and that nothing defuses. Exact on
 * purpose: `pnpm audit --prod` is not the gate `pnpm audit --audit-level=high
 * --prod` is. A job running the command under `continue-on-error`, `|| true`,
 * `set +e` or `exit 0` is reported in `defused`, not in `jobs`: it runs the
 * gate and can never fail on it.
 *
 * @param {string} ciYaml
 * @param {string} command
 * @returns {{ jobs: string[], defused: Array<{ job: string, by: string }> }}
 */
export function findAuditJobs(ciYaml, command) {
  const jobs = [];
  const defused = [];
  for (const { jobName, body } of splitWorkflowTextIntoJobs(String(ciYaml))) {
    const runs = body.split("\n").some(
      (line) =>
        line
          .trim()
          .replace(/^-\s*/, "")
          .replace(/^run:\s*/, "") === command,
    );
    if (!runs) continue;
    // Comments say what a step does not do; only the YAML itself defuses.
    const code = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const by = DEFUSERS.find(([pattern]) => pattern.test(code))?.[1];
    if (by) defused.push({ job: jobName, by });
    else jobs.push(jobName);
  }
  return { jobs, defused };
}
