---
name: review-docs
description: Use before opening a PR that changes docs/ or a user-visible surface (an API route, the tool registry, an agent template, the audit event catalogue, the settings navigation, plugin tools), and when the user asks to "review the docs", "check the docs", or "are the docs still right". Reads the changed prose against the code it describes. Runs locally — the deterministic guards run in CI, this is the layer they cannot reach.
---

# Review the docs against the code

## Why this exists

Three checks already run in CI and need no help from you:

| Guard                 | Catches                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `docs-coverage`       | an API route / audit event / tool that no doc mentions                    |
| `docs-consistency`    | an orphaned page, a `Settings → X` naming no tab, a promise with no issue |
| `check-docs-required` | a user-visible change with no `docs/` change at all                       |

Those find **missing identifiers**. They cannot read a sentence. The
2026-07-30 audit found four things that no identifier check could ever see:

- A `GET /api/settings/domain` entry whose **response fields were wrong** — the
  path and method were both fine, the body was fiction.
- A page that promised "a progress UI is planned for a later phase" while
  **describing the shipped progress UI 120 lines earlier**.
- A table of "agent templates and default permissions" listing **2 of ~35**
  templates, with the wrong tools on the one row that mattered.
- A live guide stating "Pinchy will not silently re-assign agents" about code
  that does exactly that.

Every one of those is a reading task. That is this skill.

## Scope

Review **the docs that describe what this branch changed** — not the whole
corpus. A full audit is a release-time activity (see `cut-pinchy-release`).

## Steps

### 1. Establish what actually changed

```bash
git diff --stat origin/main...HEAD
```

Separate the diff into **behaviour** (routes, tools, templates, permissions,
audit events, UI labels, defaults, limits) and **everything else**. Only the
first kind can falsify prose.

### 2. Find the prose that describes it

For each behaviour change, grep the docs for the thing itself **and for its
consequences** — the second is where staleness hides:

```bash
grep -rn "<identifier>" docs/src/content/docs/
grep -rni "<the user-facing noun>" docs/src/content/docs/
```

A rename is easy. What gets missed is the sentence three pages away that
depends on the old behaviour without naming it.

### 3. Read each hit against the code

For every doc passage you found, open the code and check, in this order:

1. **Is the claim still true?** Not "does it mention the right function" —
   does the described behaviour match what the code does.
2. **Are the specifics right?** Response fields, status codes, defaults,
   limits, required-vs-optional, which side effects fire. These are wrong far
   more often than names are, and no guard checks them.
3. **Does the page contradict itself?** Read the whole page, not the hunk. The
   contradiction is usually a "scope" or "limitations" section written earlier
   and never revisited.
4. **Does another page contradict this one?** Concept pages and guides drift
   apart because they are edited by different changes.

### 4. Check the direction nobody checks

The guards are one-directional: they ask "is everything in the code
documented?" Ask the reverse: **does the docs describe something the code no
longer has?** Grep the docs for the identifiers of anything this branch
removed or renamed. Nothing in CI asks this question.

### 5. Voice

Read `PERSONALITY.md` before writing. English, "we", plain and specific. New
prose should read like the page it lands in.

### 6. Report

For each finding: file and line, what the doc claims, what the code does, and
the one-line fix. Rank by whether a reader would act wrongly on it.

If the changed behaviour is documented correctly and no page contradicts it,
say so plainly — a clean review is a result, and inventing a finding to look
thorough wastes the next person's time.

## Before you finish

The deterministic gates are cheap; run them so the PR does not bounce:

```bash
pnpm test:scripts && pnpm format:check
```

```bash
cd docs && pnpm build && pnpm check:anchors && pnpm check:tables
```

Then record the review — this is what lets `gh pr create` through:

```bash
node scripts/mark-docs-reviewed.mjs
```

The marker holds the current HEAD sha. **Record it last**, after any fix you
made in response to the review: land another commit and the marker no longer
matches, the hook fires again, and you review the new state. That is the
intent, not an inconvenience.

If the honest answer is that the docs don't move, don't mark — put the reason
in a commit trailer instead, where the next reader will find it:

```
Docs-not-needed: gateway-only ingress, no reader-facing path
```

The same trailer waives the CI gate, so one decision is recorded once.

## What this skill is not

Not a rewrite. Do not restructure a page you were asked to check. If a page
needs restructuring, say so and let the user decide — a docs PR that also
reorganises is a docs PR nobody can review.
