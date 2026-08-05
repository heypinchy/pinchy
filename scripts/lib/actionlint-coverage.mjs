/**
 * actionlint input-coverage guard.
 *
 * `actionlint` only validates a step's `with:` keys for actions it has a schema
 * for, and those schemas are baked into the actionlint release. For an action
 * version it does not know it reports *nothing* — and a silent pass is
 * indistinguishable from a clean one.
 *
 * That is not academic here. Measured with the pinned actionlint 1.7.12:
 *
 *   docker/setup-buildx-action@v4 + `config-inline:`  -> exit 1, named
 *   docker/setup-buildx-action@v5 + `config-inline:`  -> exit 0, silent
 *
 * `config-inline` is the exact bug the actionlint step was added for. So the
 * protection expires at the next major bump of the very action it protects —
 * and `.github/dependabot.yml` proposes those weekly, grouped under
 * `patterns: ["*"]`. A major bump is also precisely when an input gets renamed.
 *
 * There is no flag for this: `actionlint -h` offers no way to error on an
 * action it does not recognise. So the coverage has to be measured, which is
 * what `scripts/check-actionlint-coverage.mjs` does — it feeds actionlint one
 * throwaway workflow per action with a bogus input and records whether it
 * complains.
 *
 * This module is the pure half: what to probe, and how to judge the results.
 *
 * See AGENTS.md § "A Hand-Maintained List That Mirrors Code Will Be Wrong" —
 * an accepted-list is only honest when it fails in BOTH directions.
 */

/**
 * The bogus input fed to each action. Deliberately unlikely to ever become a
 * real input name; if one ever does, every probe silently reports "checked".
 */
export const PROBE_INPUT = "zzz-actionlint-coverage-probe";

/**
 * Actions the pinned actionlint does not input-check, accepted with a reason.
 *
 * Keyed by the FULL ref including the version, on purpose. actionlint knows
 * `actions/checkout` — just not `@v7` — so an acceptance keyed on the repo
 * alone would outlive the version it was made for. A bump re-opens the
 * question, which is the point: that is the moment coverage changes.
 *
 * An entry whose action IS checked, or is no longer used, fails too. A verdict
 * must not outlive its evidence.
 */
export const ACCEPTED_UNCHECKED = {
  "actions/checkout@v7":
    "actionlint 1.7.12's schema DB stops at checkout v4; v7 is newer than the pin.",
  "actions/upload-pages-artifact@v5":
    "Not in actionlint's popular-actions DB at any version.",
  "anchore/sbom-action@v0":
    "Third-party, not in actionlint's popular-actions DB.",
  "lycheeverse/lychee-action@v2":
    "Third-party, not in actionlint's popular-actions DB.",
  "pnpm/action-setup@v6":
    "actionlint's DB stops at pnpm/action-setup v2; v6 is newer than the pin.",
  "softprops/action-gh-release@v3":
    "actionlint's DB stops at action-gh-release v1; v3 is newer than the pin.",
  "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.8":
    "A REMOTE reusable workflow. actionlint validates the inputs of local " +
    "reusable workflows by reading the file, but never fetches a remote one — " +
    "probed at job level (its legal shape) and it reports nothing. A permanent " +
    "gap of its own class, not a version-DB gap.",
};

/**
 * A corpus floor. A broken extractor that finds nothing would otherwise pass in
 * silence, which is how a coverage gate becomes decoration.
 */
export const MIN_EXPECTED_ACTIONS = 10;

/**
 * Pull every remote action reference out of workflow / action YAML.
 *
 * Local refs (`./.github/actions/...`) and `docker://` images are skipped:
 * actionlint does not input-check either (verified — a bogus input on a local
 * composite action is not reported), so listing them here would only produce
 * accepted-entries that assert nothing.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {string[]} sorted, unique `owner/repo[/subpath]@ref` strings
 */
export function extractActionRefs(files) {
  const refs = new Set();
  for (const { content } of files) {
    for (const line of content.split("\n")) {
      // `- uses: owner/repo@ref` — the leading `-` and quoting are optional.
      const match = line.match(
        /^\s*-?\s*uses:\s*["']?([A-Za-z0-9][\w.-]*\/[\w./-]+@[\w./-]+)["']?\s*(?:#.*)?$/,
      );
      if (match) refs.add(match[1]);
    }
  }
  return [...refs].sort();
}

/**
 * A remote reusable workflow (`owner/repo/.github/workflows/x.yml@ref`) is used
 * at job level, not as a step. Probing one as a step would make it look
 * unchecked because the probe is malformed rather than because actionlint is
 * silent — an acceptance resting on a broken measurement.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function isReusableWorkflowRef(ref) {
  return /\.ya?ml@/.test(ref);
}

/**
 * A minimal workflow that uses `ref` with one input that cannot exist, in the
 * shape that `ref` is legally used in.
 *
 * @param {string} ref
 * @returns {string} workflow YAML
 */
export function buildProbeWorkflow(ref) {
  const head = [
    "name: actionlint-coverage-probe",
    "on: push",
    "jobs:",
    "  probe:",
  ];
  const body = isReusableWorkflowRef(ref)
    ? [`    uses: ${ref}`, "    with:", `      ${PROBE_INPUT}: "x"`]
    : [
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: ${ref}`,
        "        with:",
        `          ${PROBE_INPUT}: "x"`,
      ];
  return [...head, ...body, ""].join("\n");
}

/**
 * Did actionlint report the probe input for this action?
 *
 * Matches on the probe input name rather than on the exit code: actionlint may
 * legitimately report other things about a synthetic workflow, and an exit code
 * cannot tell those apart from the answer we want.
 *
 * @param {string} output combined stdout+stderr from actionlint
 * @returns {boolean}
 */
export function probeReportedInput(output) {
  return output.includes(PROBE_INPUT);
}

/**
 * Judge a completed probe run.
 *
 * @param {{used: string[], checked: string[], accepted?: Record<string,string>}} input
 * @returns {{failures: string[]}}
 */
export function classifyCoverage({
  used,
  checked,
  accepted = ACCEPTED_UNCHECKED,
}) {
  const failures = [];

  if (used.length < MIN_EXPECTED_ACTIONS) {
    failures.push(
      `Found only ${used.length} action reference(s) under .github/ — expected at least ` +
        `${MIN_EXPECTED_ACTIONS}. The extractor is probably broken; a coverage check ` +
        `that inspects nothing passes in silence.`,
    );
    return { failures };
  }

  const usedSet = new Set(used);
  const checkedSet = new Set(checked);

  for (const ref of used) {
    if (checkedSet.has(ref) || Object.hasOwn(accepted, ref)) continue;
    failures.push(
      `${ref}: actionlint does not validate this action's inputs, and there is no ` +
        `ACCEPTED_UNCHECKED entry for it.\n` +
        `    A wrong \`with:\` key on it would ship green — that is exactly the bug ` +
        `this gate exists to catch.\n` +
        `    Fix by bumping the pinned actionlint in ci.yml (its schema DB may have ` +
        `caught up), or\n` +
        `    accept it in scripts/lib/actionlint-coverage.mjs with a reason.`,
    );
  }

  for (const [ref, reason] of Object.entries(accepted)) {
    if (!reason || !reason.trim()) {
      failures.push(`${ref}: ACCEPTED_UNCHECKED entry has no reason.`);
      continue;
    }
    if (!usedSet.has(ref)) {
      failures.push(
        `${ref}: ACCEPTED_UNCHECKED names an action no workflow uses at this version. ` +
          `Drop the entry (or update it to the version now in use) — a stale acceptance ` +
          `is the same drift one level up.`,
      );
      continue;
    }
    if (checkedSet.has(ref)) {
      failures.push(
        `${ref}: ACCEPTED_UNCHECKED says actionlint cannot check this, but it now does. ` +
          `Drop the entry — a verdict must not outlive its evidence.`,
      );
    }
  }

  return { failures };
}

/**
 * @param {string[]} failures
 * @returns {string}
 */
export function formatFailure(failures) {
  return [
    "actionlint input-coverage check failed:",
    "",
    ...failures.map((f) => `  - ${f}`),
    "",
    "actionlint only validates `with:` keys for action versions in its bundled",
    "schema database. For anything else it reports nothing, and a silent pass",
    "looks exactly like a clean one. See AGENTS.md and the comment in",
    "scripts/lib/actionlint-coverage.mjs.",
  ].join("\n");
}
