/**
 * Pure logic for the released-upgrade-section guard.
 *
 * `docs/src/content/docs/guides/upgrading.mdx` is cumulative — one
 * `## Upgrading from vA to vB` section per release, newest first. Once vB has
 * shipped, that section is a description of vB and nothing else. Editing it
 * after the fact attributes behaviour to a release that does not have it, and
 * re-renders it on docs.heypinchy.com under the wrong version.
 *
 * That happened repeatedly, and invisibly: freezing closed a section but
 * nothing opened the next one, so the next commit to write an upgrade note
 * appended it to the end of the file — which is the frozen section of the
 * release that already shipped. Measured on main on 2026-08-01, seven released
 * sections had drifted from their tag, three by gaining a whole `####` note.
 *
 * The fix for the cause is `openNextUpgradeSection` in release-logic.mjs. This
 * is the tripwire for what slips past it: for every section whose `to` is a
 * real tag, the body must still equal the body at that tag.
 *
 * See AGENTS.md § "A Released Upgrade Section Is Immutable".
 */

import { createHash } from "node:crypto";

export const UPGRADING_MDX_PATH = "docs/src/content/docs/guides/upgrading.mdx";

const SECTION_HEADING_RE =
  /^##\s+Upgrading\s+from\s+v(\d+\.\d+\.\d+)\s+to\s+(v\d+\.\d+\.\d+|%%PINCHY_VERSION%%)\s*$/gm;

/**
 * Blank out fenced code blocks, preserving length and line structure.
 *
 * Section boundaries are found by a line-anchored `^## `, and upgrade notes
 * quote markdown at people — the v0.9.1 note on knowledge-base instructions
 * shows an agent's `## Document Access` block inside a ```` ``` ```` fence. Read
 * literally, that line ends the section, and everything after it in that
 * section stops being compared against the tag. The guard stayed green on it
 * because the same parser truncates BOTH sides at the same point: symmetric
 * blindness, which reads exactly like agreement.
 *
 * Returned same-length so every index computed against the mask still addresses
 * the original string; newlines survive so the `m` flag keeps anchoring.
 *
 * @param {string} mdx
 * @returns {string}
 */
export function maskFencedBlocks(mdx) {
  const lines = mdx.split("\n");
  let fence = null; // the opening run, e.g. "```" or "~~~~"
  const masked = lines.map((line) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) fence = open[1];
      return line;
    }
    // A closing fence is the same character, at least as long as the opener.
    if (open && open[1][0] === fence[0] && open[1].length >= fence.length) {
      fence = null;
      return line;
    }
    return " ".repeat(line.length);
  });
  return masked.join("\n");
}

/**
 * Split upgrading.mdx into its `## Upgrading from vA to vB` sections.
 *
 * A section body runs to the next `## ` heading of any kind (not just the next
 * upgrade section), so the trailing prose of the file never gets attributed to
 * the oldest release. Headings inside fenced code blocks are not headings —
 * see `maskFencedBlocks`.
 *
 * @param {string} mdx
 * @returns {Array<{from: string, to: string, body: string, index: number}>}
 */
export function parseUpgradeSections(mdx) {
  const out = [];
  const mask = maskFencedBlocks(mdx);
  let m;
  SECTION_HEADING_RE.lastIndex = 0;
  while ((m = SECTION_HEADING_RE.exec(mask)) !== null) {
    const afterHeading = m.index + m[0].length;
    const next = /^## /m.exec(mask.slice(afterHeading));
    out.push({
      from: m[1],
      to: m[2],
      body: mdx.slice(
        afterHeading,
        next ? afterHeading + next.index : mdx.length,
      ),
      index: m.index,
    });
  }
  return out;
}

/**
 * Normalize a section body for comparison against the same section at its tag.
 *
 * `%%PINCHY_VERSION%%` is resolved to the concrete tag because releases before
 * v0.6.0 were tagged BEFORE `finalizeUpgradeSection` existed — their sections
 * are still placeholder-headed at their own tag, and comparing the literal
 * placeholder against the frozen text would report every one of them as drift.
 *
 * Nothing else is normalized. A whitespace-insensitive comparison would wave
 * through a re-wrapped paragraph, and a re-wrapped paragraph in a released
 * section is an edit to a released section.
 *
 * @param {string} body
 * @param {string} tag - e.g. "v0.9.0"
 * @returns {string}
 */
export function normalizeSectionBody(body, tag) {
  return body.replaceAll("%%PINCHY_VERSION%%", tag).trim();
}

/**
 * The `####` note headings in a section body, in order.
 *
 * Fenced blocks are masked for the same reason as in `parseUpgradeSections`: a
 * `####` inside a quoted markdown sample is a sample, not a note, and counting
 * it would put a phantom entry in every "gained/lost" diff.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function noteHeadings(body) {
  return [...maskFencedBlocks(body).matchAll(/^####\s+(.+?)\s*$/gm)].map(
    (m) => m[1],
  );
}

/**
 * Which `####` notes a section gained or lost since its tag.
 * @param {string} atTag
 * @param {string} now
 * @returns {{added: string[], removed: string[]}}
 */
export function diffNoteHeadings(atTag, now) {
  const before = noteHeadings(atTag);
  const after = noteHeadings(now);
  return {
    added: after.filter((h) => !before.includes(h)),
    removed: before.filter((h) => !after.includes(h)),
  };
}

/**
 * Content fingerprint of a normalized section body.
 *
 * The allowlist below pins one of these per exempted section rather than
 * exempting the section outright. An outright exemption would leave those
 * sections open forever, which is the failure this guard exists to stop — the
 * fingerprint accepts the drift that is already there and nothing more.
 *
 * @param {string} normalizedBody
 * @returns {string} sha256 hex
 */
export function fingerprintSectionBody(normalizedBody) {
  return createHash("sha256").update(normalizedBody, "utf8").digest("hex");
}

/**
 * Drift that predates this guard, accepted as a baseline so the guard could
 * land green — NOT a licence to keep editing these sections. Each entry pins
 * the exact body that was accepted (`fingerprint`), so the next edit to one of
 * them fails like any other.
 *
 * Two distinct kinds are recorded here, and the difference matters:
 *
 *  - **Retro-corrections.** The v0.2.0–v0.5.0 entries rewrite install
 *    instructions that were wrong or obsolete for those releases (the
 *    `git checkout` → `docker compose pull` switch, the v0.5.0 secrets-volume
 *    block that did not actually work as documented). Editing a released
 *    section to correct it is a legitimate act — it is what the
 *    `Allow-upgrade-note-edit:` trailer exists to authorize. These predate the
 *    trailer.
 *
 *  - **Misplaced notes — the bug itself.** A section that gained a `####` note
 *    describing a change which shipped in a LATER release. There are none left:
 *    the last two were moved into their real release under #1028, and both
 *    entries went with them, because the stale-entry check below enforces that
 *    rather than trusting it. A NEW entry of this kind is the cause coming back,
 *    not bookkeeping — fix `openNextUpgradeSection`, do not file the note here.
 *
 * Moving a note is itself an edit to a released section, so it leaves a
 * retro-correction behind in the section it moved INTO (v0.9.0 and v0.5.7
 * below). That is the honest accounting: those sections genuinely no longer
 * match their tag, and an exception that said otherwise would be a claim the
 * guard cannot verify.
 *
 * @type {Record<string, {summary: string, kind: "retro-correction"|"misplaced-note", fingerprint: string}>}
 */
export const KNOWN_PRE_GUARD_DRIFT = {
  "v0.9.0": {
    kind: "retro-correction",
    summary:
      "the two misplaced notes were moved out again (819616e2), leaving two corrections " +
      "to what v0.9.0 actually ships: the mount-your-data Aside now links the " +
      "docker-compose.override.yml route instead of merely mentioning it, and the " +
      "migration count was corrected from eleven (`0044`–`0054`) to thirteen " +
      "(`0044`–`0056`) — v0.9.0 backports its own `0056` (2a113b25). Plus, under " +
      "#1028, `Deleting a user keeps their invite history` moved IN from v0.8.0's " +
      "section: migration `0044` is what makes that foreign key `ON DELETE SET " +
      "NULL`, and `0044` does not exist at v0.8.0 — that tree stops at `0043`",
    fingerprint:
      "92ab76c5d27281beebda57324972488c2eac53a630a1a17b7ee3075918205566",
  },
  "v0.5.7": {
    kind: "retro-correction",
    summary:
      "gained `Integration audit event names`, moved IN from v0.5.4's section under " +
      "#1028. The rename ships here: `integration.created` first appears in the tree " +
      "at v0.5.7 (a4b51463), and v0.5.4 through v0.5.6 do not contain it — the issue " +
      "named v0.5.5 without checking",
    fingerprint:
      "6c88ebfa7a12f756a14c422fda4d386f2af3c88b4f711138a1a9c7592e78c2c9",
  },
  "v0.5.0": {
    kind: "retro-correction",
    summary:
      "the custom-compose snippet was corrected (#281: the documented tmpfs block did " +
      "not match what v0.5.0 actually needs — Pinchy writes the secrets file, so the " +
      "volume must be mounted into both services), plus a BETTER_AUTH_URL recommendation",
    fingerprint:
      "317108334be2817cd7a8d91551d9e56f8100ed3d0fda71f301eeb989226bc46a",
  },
  "v0.4.0": {
    kind: "retro-correction",
    summary:
      "gained the SSH-key recovery walkthrough for early Hetzner deployments that " +
      "followed a guide version saying to skip the key — those hosts could not run the " +
      "upgrade at all without it",
    fingerprint:
      "4f9e9fcbd5c4c3b80639d6b890920b5e078ca98edb14f2a06097901e3573d700",
  },
  "v0.3.0": {
    kind: "retro-correction",
    summary:
      "install instructions rewritten from `git checkout` + `up --build` to the " +
      "pinned-compose + `docker compose pull` flow, which is how these versions are " +
      "installed now",
    fingerprint:
      "bafbd817fa68b7a20ff874855ca519fe119f3cbafa4ad5eec9c47d9327cea01f",
  },
  "v0.2.1": {
    kind: "retro-correction",
    summary: "same `git checkout` → pinned-compose rewrite as v0.3.0",
    fingerprint:
      "56d49b15685b4768d17879e678c0c846e90128b3e6c63baa275b62236c87ac18",
  },
  "v0.2.0": {
    kind: "retro-correction",
    summary:
      "same rewrite, prose half only (`rebuild with up --build` → `pull the new images`)",
    fingerprint:
      "3d8cfa86d1b514f54bf042e2896315184ccb6056834fa9befa129c54aab25d4a",
  },
};

/**
 * Compare every released section against its tag.
 *
 * Sections whose `to` is `%%PINCHY_VERSION%%` are out of scope — that is the
 * open one, and the whole point of this guard is that notes belong there.
 *
 * A tag the caller cannot read yields a WARNING, never a failure. CI checkouts
 * are shallow and a guard that hard-fails on a missing tag would fail on
 * infrastructure rather than on content. The cost of the soft path is that the
 * guard silently covers less; `.github/workflows/ci.yml` fetches tags in the
 * `quality` job so that stays theoretical, and `validateCiWiring` below fails
 * if that wiring is removed.
 *
 * That soft path has one edge the caller must close: if NO tag resolves, every
 * section warns and this returns zero problems — green, having compared
 * nothing. `validateCiWiring` cannot see that, because it reads what the YAML
 * says rather than what `git show` answers. So the counts come back too, and
 * the repo check fails in CI when `checked` is 0 while `released` is not.
 *
 * @param {object} args
 * @param {string} args.mdx - current upgrading.mdx
 * @param {(tag: string) => string|null} args.readTaggedMdx - file contents at a
 *   tag, or null when the tag/blob is not available locally
 * @param {Record<string, {summary: string, kind: string, fingerprint: string}>} [args.knownDrift]
 * @returns {{problems: Array<{kind: "drift"|"stale-allowlist", tag: string, message: string}>, warnings: string[], accepted: string[], released: number, checked: number}}
 */
export function checkReleasedSections({
  mdx,
  readTaggedMdx,
  knownDrift = KNOWN_PRE_GUARD_DRIFT,
}) {
  const problems = [];
  const warnings = [];
  const accepted = [];
  const seenTags = new Set();
  let released = 0;
  let checked = 0;

  for (const section of parseUpgradeSections(mdx)) {
    if (section.to === "%%PINCHY_VERSION%%") continue;
    const tag = section.to;
    seenTags.add(tag);
    released += 1;

    const tagged = readTaggedMdx(tag);
    if (tagged == null) {
      warnings.push(
        `${tag}: tag not available locally — section not checked. ` +
          `In CI this means the checkout did not fetch tags.`,
      );
      continue;
    }
    checked += 1;

    // Match on `from` alone: at its own tag the section may still be
    // placeholder-headed (releases before auto-finalize existed).
    const atTag = parseUpgradeSections(tagged).find(
      (s) => s.from === section.from,
    );
    if (!atTag) {
      problems.push({
        kind: "drift",
        tag,
        message:
          `"Upgrading from v${section.from} to ${tag}" does not exist at ${tag} — ` +
          `the whole section was added after that release shipped.`,
      });
      continue;
    }

    const before = normalizeSectionBody(atTag.body, tag);
    const now = normalizeSectionBody(section.body, tag);
    const entry = knownDrift[tag];

    if (before === now) {
      if (entry) {
        problems.push({
          kind: "stale-allowlist",
          tag,
          message:
            `KNOWN_PRE_GUARD_DRIFT["${tag}"] no longer describes anything: the section ` +
            `now matches ${tag} exactly. Delete the entry — a verdict must not ` +
            `outlive its evidence.`,
        });
      }
      continue;
    }

    const { added, removed } = diffNoteHeadings(before, now);
    const fingerprint = fingerprintSectionBody(now);

    if (entry && entry.fingerprint === fingerprint) {
      accepted.push(`${tag}: ${entry.summary}`);
      continue;
    }

    const detail = [
      ...added.map((h) => `    + #### ${h}`),
      ...removed.map((h) => `    - #### ${h}`),
    ];
    if (detail.length === 0) detail.push("    (prose only — no #### changed)");

    if (entry) {
      problems.push({
        kind: "drift",
        tag,
        message:
          `"Upgrading from v${section.from} to ${tag}" drifted FURTHER than the baseline ` +
          `recorded in KNOWN_PRE_GUARD_DRIFT["${tag}"] (${entry.summary}).\n` +
          `${detail.join("\n")}\n` +
          `    If this edit is intended and authorized, update that entry's ` +
          `fingerprint to:\n      ${fingerprint}`,
      });
      continue;
    }

    problems.push({
      kind: "drift",
      tag,
      message:
        `"Upgrading from v${section.from} to ${tag}" no longer matches its content at ${tag}:\n` +
        `${detail.join("\n")}\n` +
        `    ${tag} has shipped, so that section describes ${tag} and nothing else. ` +
        `An upgrade note for an unreleased fix belongs in the %%PINCHY_VERSION%% section ` +
        `at the top of the file.`,
    });
  }

  for (const tag of Object.keys(knownDrift)) {
    if (!seenTags.has(tag)) {
      problems.push({
        kind: "stale-allowlist",
        tag,
        message:
          `KNOWN_PRE_GUARD_DRIFT["${tag}"] names a section that no longer exists in ` +
          `${UPGRADING_MDX_PATH}. Delete the entry.`,
      });
    }
  }

  return { problems, warnings, accepted, released, checked };
}

/**
 * The corpus floor: did this run compare anything at all?
 *
 * Kept separate from `checkReleasedSections` so the soft path stays soft where
 * it should be. One unreadable tag is a shallow clone and must not fail a
 * build. EVERY tag unreadable is not a content verdict at all — it is the guard
 * reporting green on an empty comparison, which is exactly how a coverage gate
 * becomes decoration. The caller passes `strict` for the environment where
 * silence is dangerous (CI), and leaves it off where a shallow local clone is a
 * legitimate way to work.
 *
 * @param {{released: number, checked: number}} counts
 * @param {boolean} strict
 * @returns {string|null} an error message, or null when the run is usable
 */
export function emptyCorpusError({ released, checked }, strict) {
  if (!strict || released === 0 || checked > 0) return null;
  return (
    `${UPGRADING_MDX_PATH}: ${released} released section(s), 0 checked — not a single ` +
    `release tag could be read, so this guard compared nothing and would have passed ` +
    `on any drift.\n` +
    `In CI: the checkout must set \`fetch-tags: true\` (see the \`quality\` job).\n` +
    `Locally: \`git fetch --tags\`.`
  );
}

// An edit to a released section is authorized the same way a test deletion is:
// a maintainer applied the PR label, or a commit trailer references an issue.
// A bare reason ("fixing a typo") is not enough — the point is that the edit is
// greppable and has somewhere the reasoning lives.
const ISSUE_REF_RE =
  /#\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
// Anchored at line start (m) so prose that merely names the trailer — this
// paragraph, AGENTS.md, the guard's own failure message — is not mistaken for
// one. Global (g) so a real trailer is still found behind an earlier commit's
// mention or an invalid-ref trailer.
const TRAILER_RE = /^[ \t]*Allow-upgrade-note-edit:[ \t]*(.+)$/gim;

/**
 * Decide whether editing a released upgrade section is explicitly authorized.
 * @param {{ envValue?: string, messages?: string[] }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function parseOverride({ envValue, messages = [] } = {}) {
  const env = (envValue ?? "").trim().toLowerCase();
  if (env === "true" || env === "1" || env === "yes") {
    return { allowed: true, reason: "allow-upgrade-note-edit label" };
  }
  for (const message of messages) {
    for (const match of message.matchAll(TRAILER_RE)) {
      const ref = match[1].match(ISSUE_REF_RE);
      if (ref) {
        return {
          allowed: true,
          reason: `Allow-upgrade-note-edit trailer (${ref[0]})`,
        };
      }
    }
  }
  return { allowed: false, reason: "" };
}

/**
 * Format problems into one actionable failure message.
 * @param {Array<{kind: string, tag: string, message: string}>} problems
 * @returns {string}
 */
export function formatProblems(problems) {
  const lines = problems.map((p) => `  • [${p.kind}] ${p.message}`);
  return (
    `${UPGRADING_MDX_PATH}: ${problems.length} problem(s) in already-released sections:\n` +
    `${lines.join("\n")}\n\n` +
    `A section for a version that has shipped is frozen. If this edit is a genuine ` +
    `correction to that release's notes, authorize it:\n` +
    `  • add a commit trailer referencing the issue:\n` +
    `        Allow-upgrade-note-edit: #<issue-number>\n` +
    `    (amend the commit, or add an empty commit with the trailer), OR\n` +
    `  • apply the "allow-upgrade-note-edit" label to the PR — but note that a\n` +
    `    merge_group run carries no PR labels, so a label-only authorization passes\n` +
    `    PR CI and is then rejected by the merge queue. Use the trailer for anything\n` +
    `    that has to merge.\n` +
    `A [stale-allowlist] problem is never authorized this way — delete the entry.\n` +
    `See AGENTS.md § "A Released Upgrade Section Is Immutable".`
  );
}

/**
 * Assert `.github/workflows/ci.yml` still gives this guard what it needs.
 *
 * Two things, both of which fail SILENTLY if removed — the guard would keep
 * passing while checking nothing:
 *
 *  - the `quality` job's checkout must fetch tags, or every section skips with
 *    a warning (depth 1 is enough: a shallow-fetched tag still carries its own
 *    tree, which is all `git show <tag>:<path>` reads);
 *  - the `Test (root scripts)` step must pass the label through as
 *    `ALLOW_UPGRADE_NOTE_EDIT`, or the label override silently stops working
 *    and only the trailer remains.
 *
 * @param {string} ciYaml
 * @returns {string[]} error messages, empty when wired correctly
 */
export function validateCiWiring(ciYaml) {
  if (typeof ciYaml !== "string") return ["ci.yml is unreadable"];
  // Strip comments first: a commented-out `fetch-tags: true` — or this very
  // rule quoted in a step's prose — leaves the substring in the file while CI
  // no longer does it. `#` only counts at line start or after whitespace, so a
  // `#` inside a command string cannot truncate the line.
  const withoutComments = ciYaml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

  // The `quality` job block: from `  quality:` to the next top-level job key.
  const start = withoutComments.search(/^ {2}quality:$/m);
  if (start === -1) return ["ci.yml has no `quality:` job"];
  const rest = withoutComments.slice(start + 1);
  const end = rest.search(/^ {2}\S/m);
  const job = rest.slice(0, end === -1 ? rest.length : end);

  const errors = [];
  if (!/fetch-tags:\s*true/.test(job)) {
    errors.push(
      "CI `quality` job checkout must set `fetch-tags: true` — without the tags " +
        "the released-section guard compares nothing and passes.",
    );
  }
  if (!job.includes("ALLOW_UPGRADE_NOTE_EDIT")) {
    errors.push(
      "CI `quality` job must pass ALLOW_UPGRADE_NOTE_EDIT to `pnpm test:scripts` " +
        "so the `allow-upgrade-note-edit` label works as an override.",
    );
  }
  return errors;
}
