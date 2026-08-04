import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPGRADING_MDX_PATH,
  KNOWN_PRE_GUARD_DRIFT,
  parseUpgradeSections,
  maskFencedBlocks,
  normalizeSectionBody,
  noteHeadings,
  diffNoteHeadings,
  fingerprintSectionBody,
  checkReleasedSections,
  emptyCorpusError,
  parseOverride,
  formatProblems,
  validateCiWiring,
} from "./upgrading-released-sections.mjs";
import { commitLogArgs } from "./check-test-deletions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// ─── fixtures ────────────────────────────────────────────────────────────────

const AT_TAG = [
  "## Upgrading from v0.8.0 to v0.9.0",
  "",
  "### Breaking changes",
  "",
  "None.",
  "",
  "### Upgrade notes",
  "",
  "#### Knowledge Base agents",
  "",
  "Opt-in, off by default.",
  "",
  "## Upgrading from v0.7.0 to v0.8.0",
  "",
  "Older, untouched.",
  "",
].join("\n");

/** The same file with one note appended to the released v0.9.0 section. */
const WITH_MISPLACED_NOTE = AT_TAG.replace(
  "Opt-in, off by default.\n",
  [
    "Opt-in, off by default.",
    "",
    "#### A provider key that can't reach the runtime now says so",
    "",
    "Landed after v0.9.0 shipped.",
    "",
  ].join("\n"),
);

const readerFor = (tagged) => (tag) => (tag === "v0.9.0" ? tagged : AT_TAG);

// ─── parseUpgradeSections ────────────────────────────────────────────────────

test("parseUpgradeSections finds every version section, newest first", () => {
  const sections = parseUpgradeSections(AT_TAG);
  assert.deepEqual(
    sections.map((s) => `${s.from}->${s.to}`),
    ["0.8.0->v0.9.0", "0.7.0->v0.8.0"],
  );
});

test("parseUpgradeSections stops a body at the next `## ` heading of ANY kind", () => {
  const mdx = [
    "## Upgrading from v0.8.0 to v0.9.0",
    "",
    "Section body.",
    "",
    "## Restoring from backup",
    "",
    "Trailing prose that belongs to no release.",
  ].join("\n");
  const [section] = parseUpgradeSections(mdx);
  assert.match(section.body, /Section body\./);
  assert.doesNotMatch(section.body, /Trailing prose/);
});

test("parseUpgradeSections keeps the open placeholder section", () => {
  const mdx = "## Upgrading from v0.9.0 to %%PINCHY_VERSION%%\n\nOpen.\n";
  assert.equal(parseUpgradeSections(mdx)[0].to, "%%PINCHY_VERSION%%");
});

// The real case: v0.9.1's knowledge-base note quotes an agent's instructions,
// and that sample contains a line starting `## `. Taken as a heading it ends
// the section, and the rest of the note stops being compared to the tag — while
// the guard reports green, because the same parser cuts both sides at the same
// place. Symmetric blindness reads exactly like agreement.
test("parseUpgradeSections does not end a section on a `## ` inside a code fence", () => {
  const mdx = [
    "## Upgrading from v0.8.0 to v0.9.0",
    "",
    "Shorten the block to what a new agent gets:",
    "",
    "```markdown",
    "## Document Access",
    "",
    "- `/data/handbook`",
    "```",
    "",
    "Keep whichever paths the old block listed.",
    "",
    "## Upgrading from v0.7.0 to v0.8.0",
    "",
    "Older.",
  ].join("\n");
  const [section] = parseUpgradeSections(mdx);
  assert.match(section.body, /Keep whichever paths/);
  assert.doesNotMatch(section.body, /Older\./);
});

test("noteHeadings ignores a `####` inside a code fence", () => {
  const body = [
    "#### A real note",
    "",
    "```markdown",
    "#### Not a note, a sample",
    "```",
  ].join("\n");
  assert.deepEqual(noteHeadings(body), ["A real note"]);
});

// Prettier writes ````markdown when the sample itself contains ```, so the
// nesting this file's own fixtures reach is real. The masking itself — fence
// lengths, `~~~`, the unclosed case, length preservation — is unit-tested in
// mdx-fences.test.mjs, which is also where the release script reads it from.
test("parseUpgradeSections is not fooled by a ``` nested inside a ```` fence", () => {
  const mdx = [
    "## Upgrading from v0.8.0 to v0.9.0",
    "",
    "````markdown",
    "```",
    "## Inside",
    "````",
    "",
    "Still v0.9.0.",
    "",
    "## Upgrading from v0.7.0 to v0.8.0",
    "",
    "Older.",
  ].join("\n");
  const [section] = parseUpgradeSections(mdx);
  assert.match(section.body, /Still v0\.9\.0\./);
  assert.doesNotMatch(section.body, /Older\./);
});

// ─── normalizeSectionBody ────────────────────────────────────────────────────

test("normalizeSectionBody resolves the placeholder so pre-auto-finalize tags compare equal", () => {
  // Releases before v0.6.0 were tagged before finalizeUpgradeSection existed:
  // their section is still placeholder-headed AT THEIR OWN TAG. Without this,
  // every one of them would report as drift.
  assert.equal(
    normalizeSectionBody("Bump to %%PINCHY_VERSION%% now.", "v0.5.4"),
    normalizeSectionBody("Bump to v0.5.4 now.", "v0.5.4"),
  );
});

test("normalizeSectionBody does NOT collapse whitespace inside the body", () => {
  // A re-wrapped paragraph in a released section is an edit to a released
  // section. Only leading/trailing whitespace is forgiven.
  assert.notEqual(
    normalizeSectionBody("a b\nc", "v1.0.0"),
    normalizeSectionBody("a\nb c", "v1.0.0"),
  );
  assert.equal(
    normalizeSectionBody("\n\nsame\n\n", "v1.0.0"),
    normalizeSectionBody("same", "v1.0.0"),
  );
});

// ─── noteHeadings / diffNoteHeadings ─────────────────────────────────────────

test("noteHeadings reads #### notes only, not ### subsections", () => {
  assert.deepEqual(noteHeadings("### Upgrade notes\n\n#### A note\n"), [
    "A note",
  ]);
});

test("diffNoteHeadings names what a section gained and lost", () => {
  const diff = diffNoteHeadings(
    "#### Kept\n#### Gone\n",
    "#### Kept\n#### New\n",
  );
  assert.deepEqual(diff, { added: ["New"], removed: ["Gone"] });
});

// ─── checkReleasedSections ───────────────────────────────────────────────────

test("checkReleasedSections is quiet when every released section matches its tag", () => {
  const { problems, warnings } = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {},
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
});

test("checkReleasedSections flags a note appended to a released section", () => {
  const { problems } = checkReleasedSections({
    mdx: WITH_MISPLACED_NOTE,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {},
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "drift");
  assert.equal(problems[0].tag, "v0.9.0");
  assert.match(problems[0].message, /\+ #### A provider key/);
  assert.match(problems[0].message, /%%PINCHY_VERSION%% section/);
});

test("checkReleasedSections flags a note REMOVED from a released section too", () => {
  const { problems } = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: readerFor(WITH_MISPLACED_NOTE),
    knownDrift: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /- #### A provider key/);
});

test("checkReleasedSections flags prose-only drift and says so", () => {
  const edited = AT_TAG.replace(
    "Opt-in, off by default.",
    "Opt-in. Off by default.",
  );
  const { problems } = checkReleasedSections({
    mdx: edited,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /prose only/);
});

test("checkReleasedSections ignores the open %%PINCHY_VERSION%% section", () => {
  const withOpen = `## Upgrading from v0.9.0 to %%PINCHY_VERSION%%\n\n#### Brand new note\n\n${AT_TAG}`;
  const { problems } = checkReleasedSections({
    mdx: withOpen,
    // The open section's "tag" must never be read — it is not a release.
    readTaggedMdx: (tag) => {
      assert.notEqual(tag, "%%PINCHY_VERSION%%");
      return readerFor(AT_TAG)(tag);
    },
    knownDrift: {},
  });
  assert.deepEqual(problems, []);
});

test("checkReleasedSections flags a whole section that did not exist at its tag", () => {
  const invented = [
    "## Upgrading from v0.8.5 to v0.9.0",
    "",
    "Retro-invented section.",
    "",
  ].join("\n");
  const { problems } = checkReleasedSections({
    mdx: invented,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /does not exist at v0\.9\.0/);
});

test("checkReleasedSections WARNS, never fails, when a tag is unavailable", () => {
  // CI checkouts are shallow. A guard that hard-fails on a missing tag fails on
  // infrastructure instead of on content.
  const { problems, warnings } = checkReleasedSections({
    mdx: WITH_MISPLACED_NOTE,
    readTaggedMdx: () => null,
    knownDrift: {},
  });
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /tag not available locally/);
});

// ─── the corpus floor ────────────────────────────────────────────────────────

test("checkReleasedSections reports how many sections it actually compared", () => {
  const readable = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {},
  });
  assert.deepEqual(
    { released: readable.released, checked: readable.checked },
    { released: 2, checked: 2 },
  );

  const halfReadable = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: (tag) => (tag === "v0.9.0" ? AT_TAG : null),
    knownDrift: {},
  });
  assert.deepEqual(
    { released: halfReadable.released, checked: halfReadable.checked },
    { released: 2, checked: 1 },
  );
});

test("emptyCorpusError fires when no tag resolved at all — the silent-green hole", () => {
  // The failure `validateCiWiring` structurally cannot see: the YAML still says
  // `fetch-tags: true`, `git show` answers nothing, every section warns, and the
  // guard passes having compared zero sections.
  const message = emptyCorpusError({ released: 20, checked: 0 }, true);
  assert.match(message, /0 checked/);
  assert.match(message, /fetch-tags: true/);
});

test("emptyCorpusError stays quiet where a shallow clone is legitimate", () => {
  // Not strict (no CI): a contributor working from a `--depth=1 --no-tags`
  // clone gets the warnings, not a red suite. The hard failure belongs where
  // the green is load-bearing.
  assert.equal(emptyCorpusError({ released: 20, checked: 0 }, false), null);
  // Partial coverage is the documented soft path, strict or not.
  assert.equal(emptyCorpusError({ released: 20, checked: 1 }, true), null);
  // A file with no released sections yet has nothing to compare, and that is
  // not a broken checkout.
  assert.equal(emptyCorpusError({ released: 0, checked: 0 }, true), null);
});

// ─── the allowlist ───────────────────────────────────────────────────────────

test("an allowlist entry accepts exactly the body it pins", () => {
  const section = parseUpgradeSections(WITH_MISPLACED_NOTE)[0];
  const knownDrift = {
    "v0.9.0": {
      kind: "misplaced-note",
      summary: "pre-guard baseline",
      fingerprint: fingerprintSectionBody(
        normalizeSectionBody(section.body, "v0.9.0"),
      ),
    },
  };
  const { problems, accepted } = checkReleasedSections({
    mdx: WITH_MISPLACED_NOTE,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift,
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(accepted, ["v0.9.0: pre-guard baseline"]);
});

test("an allowlist entry does NOT exempt the section from further drift", () => {
  // The whole point of pinning a fingerprint rather than the section name: an
  // outright exemption would leave these sections open forever, which is the
  // failure this guard exists to stop.
  const section = parseUpgradeSections(WITH_MISPLACED_NOTE)[0];
  const knownDrift = {
    "v0.9.0": {
      kind: "misplaced-note",
      summary: "pre-guard baseline",
      fingerprint: fingerprintSectionBody(
        normalizeSectionBody(section.body, "v0.9.0"),
      ),
    },
  };
  const drifted = WITH_MISPLACED_NOTE.replace(
    "Landed after v0.9.0 shipped.",
    "Landed after v0.9.0 shipped.\n\n#### And another one\n\nAlso late.",
  );
  const { problems } = checkReleasedSections({
    mdx: drifted,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /drifted FURTHER than the baseline/);
  // The message must carry the new fingerprint, or an authorized edit cannot
  // update the entry without reverse-engineering the hash.
  assert.match(
    problems[0].message,
    new RegExp(
      fingerprintSectionBody(
        normalizeSectionBody(parseUpgradeSections(drifted)[0].body, "v0.9.0"),
      ),
    ),
  );
});

test("an allowlist entry whose section now matches its tag is flagged as stale", () => {
  const { problems } = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {
      "v0.9.0": {
        kind: "misplaced-note",
        summary: "x",
        fingerprint: "deadbeef",
      },
    },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "stale-allowlist");
  assert.match(problems[0].message, /must not\s+outlive its evidence/);
});

test("an allowlist entry naming a section that no longer exists is flagged as stale", () => {
  const { problems } = checkReleasedSections({
    mdx: AT_TAG,
    readTaggedMdx: readerFor(AT_TAG),
    knownDrift: {
      "v9.9.9": {
        kind: "retro-correction",
        summary: "x",
        fingerprint: "deadbeef",
      },
    },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "stale-allowlist");
  assert.match(problems[0].message, /no longer exists/);
});

test("every KNOWN_PRE_GUARD_DRIFT entry is documented and classified", () => {
  for (const [tag, entry] of Object.entries(KNOWN_PRE_GUARD_DRIFT)) {
    assert.match(tag, /^v\d+\.\d+\.\d+$/, `${tag} is not a release tag`);
    assert.match(
      entry.fingerprint,
      /^[0-9a-f]{64}$/,
      `${tag} has no sha256 fingerprint`,
    );
    assert.ok(
      ["retro-correction", "misplaced-note"].includes(entry.kind),
      `${tag} has an unknown kind "${entry.kind}"`,
    );
    assert.ok(
      entry.summary && entry.summary.length > 30,
      `${tag} needs a summary saying what the drift IS`,
    );
    // A misplaced note is a bug being carried, not a decision — it needs
    // somewhere the work lives, same contract as a tracked test skip.
    if (entry.kind === "misplaced-note") {
      assert.match(
        entry.summary,
        /#\d+/,
        `${tag} is a misplaced note and must cite a tracking issue`,
      );
    }
  }
});

// ─── the override ────────────────────────────────────────────────────────────

test("parseOverride accepts the PR label", () => {
  assert.equal(parseOverride({ envValue: "true" }).allowed, true);
});

test("parseOverride ignores a false-y label value", () => {
  assert.equal(parseOverride({ envValue: "false" }).allowed, false);
  assert.equal(parseOverride({ envValue: "" }).allowed, false);
});

test("parseOverride accepts a trailer that references an issue", () => {
  const result = parseOverride({
    messages: [
      "docs: correct the v0.5.0 snippet\n\nAllow-upgrade-note-edit: #281\n",
    ],
  });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /#281/);
});

test("parseOverride rejects a trailer with a bare reason", () => {
  assert.equal(
    parseOverride({
      messages: ["docs: fix\n\nAllow-upgrade-note-edit: just a typo\n"],
    }).allowed,
    false,
  );
});

test("parseOverride ignores the phrase in prose, only a line-start trailer counts", () => {
  assert.equal(
    parseOverride({
      messages: [
        "docs: explain that Allow-upgrade-note-edit: #1 authorizes an edit\n",
      ],
    }).allowed,
    false,
  );
});

test("parseOverride finds a valid trailer behind an earlier invalid one", () => {
  // `git log` concatenates every commit message in the range; stopping at the
  // first match would miss the authorizing commit.
  const result = parseOverride({
    messages: [
      "first\n\nAllow-upgrade-note-edit: no ref\n\nsecond\n\nAllow-upgrade-note-edit: #42\n",
    ],
  });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /#42/);
});

// ─── formatProblems ──────────────────────────────────────────────────────────

test("formatProblems names both authorization routes and excludes stale entries from them", () => {
  const message = formatProblems([
    { kind: "drift", tag: "v0.9.0", message: "something drifted" },
  ]);
  assert.match(message, /Allow-upgrade-note-edit: #<issue-number>/);
  assert.match(message, /allow-upgrade-note-edit" label/);
  assert.match(message, /\[stale-allowlist\] problem is never authorized/);
});

test("formatProblems warns that a label does not survive the merge queue", () => {
  // A merge_group run carries no PR labels, so a label-only authorization is
  // green on the PR and rejected by the queue — the message has to say so where
  // the person reading it is, not only in AGENTS.md.
  const message = formatProblems([
    { kind: "drift", tag: "v0.9.0", message: "something drifted" },
  ]);
  assert.match(message, /merge_group run carries no PR labels/);
});

// ─── CI wiring ───────────────────────────────────────────────────────────────

const CI_YAML_PATH = join(ROOT, ".github", "workflows", "ci.yml");

test("validateCiWiring flags a quality job that does not fetch tags", () => {
  const yaml = [
    "jobs:",
    "  quality:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "    env:",
    "      ALLOW_UPGRADE_NOTE_EDIT: x",
    "  other:",
    "    steps: []",
  ].join("\n");
  assert.match(validateCiWiring(yaml).join("\n"), /fetch-tags/);
});

test("validateCiWiring flags a quality job that drops the label override", () => {
  const yaml = [
    "jobs:",
    "  quality:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-tags: true",
    "  other:",
    "    steps: []",
  ].join("\n");
  assert.match(validateCiWiring(yaml).join("\n"), /ALLOW_UPGRADE_NOTE_EDIT/);
});

test("validateCiWiring does not accept a COMMENTED-OUT fetch-tags", () => {
  // The silent un-wiring this check exists to catch: the substring survives in
  // the file while CI stops doing it.
  const yaml = [
    "jobs:",
    "  quality:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          # fetch-tags: true",
    "    env:",
    "      ALLOW_UPGRADE_NOTE_EDIT: x",
    "  other:",
    "    steps: []",
  ].join("\n");
  assert.match(validateCiWiring(yaml).join("\n"), /fetch-tags/);
});

test("validateCiWiring does not read another job's fetch-tags as the quality job's", () => {
  const yaml = [
    "jobs:",
    "  changes:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-tags: true",
    "  quality:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "    env:",
    "      ALLOW_UPGRADE_NOTE_EDIT: x",
  ].join("\n");
  assert.match(validateCiWiring(yaml).join("\n"), /fetch-tags/);
});

test("validateCiWiring accepts a correctly wired quality job", () => {
  const yaml = [
    "jobs:",
    "  quality:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-tags: true",
    "      - name: Test (root scripts)",
    "        env:",
    "          ALLOW_UPGRADE_NOTE_EDIT: ${{ true }}",
    "        run: pnpm test:scripts",
    "  other:",
    "    steps: []",
  ].join("\n");
  assert.deepEqual(validateCiWiring(yaml), []);
});

test("the real ci.yml gives this guard tags and the label override", () => {
  assert.deepEqual(validateCiWiring(readFileSync(CI_YAML_PATH, "utf8")), []);
});

// ─── the repo check ──────────────────────────────────────────────────────────

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitSafe(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

test("no already-released section of upgrading.mdx has drifted from its tag", () => {
  const { problems, warnings, accepted, released, checked } =
    checkReleasedSections({
      mdx: readFileSync(join(ROOT, UPGRADING_MDX_PATH), "utf8"),
      readTaggedMdx: (tag) => gitSafe(["show", `${tag}:${UPGRADING_MDX_PATH}`]),
    });

  for (const warning of warnings) {
    // `::warning::` so a CI run that could not read its tags says so in the
    // annotations instead of passing silently.
    console.log(`::warning::[upgrading-released-sections] ${warning}`);
  }
  for (const note of accepted) {
    console.log(
      `[upgrading-released-sections] known pre-guard drift — ${note}`,
    );
  }

  // Before judging the content: did this run read anything? An annotation
  // nobody opens is not a gate, and in CI a zero-comparison pass is the guard
  // reporting on its own silence.
  const empty = emptyCorpusError(
    { released, checked },
    Boolean(process.env.CI),
  );
  assert.ok(empty === null, empty ?? "");

  if (problems.length === 0) return;

  const drift = problems.filter((p) => p.kind === "drift");
  const stale = problems.filter((p) => p.kind === "stale-allowlist");

  // Read the branch's own commit messages for a trailer. In CI, HEAD is a
  // shallow merge commit whose feature-side parent is a graft, so the trailer
  // is only reachable through the (ungrafted) PR head sha — same resolution the
  // test-removal guard needs, and the same helper.
  const mergeBase = gitSafe(["merge-base", "origin/main", "HEAD"]);
  const log = gitSafe(commitLogArgs(mergeBase, process.env.PR_HEAD_SHA)) || "";
  const override = parseOverride({
    envValue: process.env.ALLOW_UPGRADE_NOTE_EDIT,
    messages: [log],
  });

  // A stale allowlist entry is bookkeeping, never an edit — the override does
  // not cover it, because "keep a verdict whose evidence is gone" is not
  // something anyone should be able to authorize.
  const unresolved = override.allowed ? stale : problems;
  if (override.allowed && drift.length > 0) {
    console.log(
      `[upgrading-released-sections] ${drift.length} released-section edit(s) ` +
        `allowed via ${override.reason}`,
    );
  }

  assert.equal(unresolved.length, 0, formatProblems(unresolved));
});
