---
name: triage-issues
description: Use when triaging the GitHub issue backlog — the weekly pass over new issues, or a full sweep to clear out issues that are already done, already covered, or were never real. Also when the user says "triage the issues", "clean up the backlog", "welche Issues können wir zumachen", or asks how many open issues are actually still open. Verifies against the code before closing anything.
---

# Triage the issue backlog

## Why this exists

Issues here arrive faster than they close, and the backlog does not decay in
the way the usual tooling assumes. Measured on 2026-08-01 against 148 open
issues:

| Signal                                   | Count |
| ---------------------------------------- | ----- |
| a merged PR already references the issue | 54    |
| never categorised by anyone              | 28    |
| an `enhancement` with zero comments      | 40    |
| untouched for more than 90 days          | 16    |

**The last row is why there is no stale-bot here.** Close-after-90-days would
find 16 of 148 and be wrong about most of them. The backlog is not abandoned,
it is unresolved — the real mass is work that is _done_ but still open, because
a PR titled `… (#796)` does not close anything without `Closes #796`.

## The two modes

Same method, different scope. The full sweep establishes the state the weekly
pass depends on.

|           | Full sweep                   | Weekly pass            |
| --------- | ---------------------------- | ---------------------- |
| Scope     | everything                   | the `untriaged` bucket |
| Expect    | dozens of closures           | 5–15 issues            |
| Ends with | every open issue categorised | same                   |

The weekly filter only works while the invariant below holds. Until the first
full sweep has run, run the full sweep.

## Step 1 — Sweep

```bash
node scripts/triage-sweep.mjs > docs/plans/triage-$(date +%F).md
```

One GraphQL pass, a few seconds, no writes to GitHub. It sorts every open issue
into a bucket by evidence and prints markdown. It borrows credentials from
`gh`, so `gh auth login` must have happened.

**Write it to a file and keep the verdicts there as you go.** A full sweep is
54 candidates times three checks; that outlives a context window, and
re-verifying from scratch after a compaction is the difference between a pass
that finishes and one that gets abandoned half-done. `docs/plans/` is
gitignored, so the working file never lands in a commit.

**The sweep never reaches a verdict.** It reports that #465 has a merged PR in
its timeline; it does not report that #465 is done. Of the 54 in
`closed-by-pr`, some are tracking issues that legitimately accumulate merged
PRs for months — #543 and #669 both look exactly like a zombie and both are
alive. Treat the bucket as a candidate list.

## Step 2 — Verify, per candidate

This is the actual work, and it is the reason this is a skill and not a cron
job. For each `closed-by-pr` candidate, three checks — in this order, stopping
as soon as one settles it:

1. **Read the PR.** `gh pr view <n>` — does it claim to do what the issue asks,
   or does it merely mention the number in passing?
2. **Grep `main` for the thing the issue names.** The symbol, the file, the
   flag. `git grep -n <symbol> origin/main -- <path>`. An issue asking for a
   function that now exists is done; an issue asking for behaviour is not
   settled by a grep, and needs the PR read.
3. **Check for unlanded work.** `git branch -a` and `git worktree list`, by
   issue number _and_ by keyword. Finished-but-never-pushed branches sit
   around here regularly. That is not "done", it is "started".

Three verdicts, and **"partly" is a real one** — #799 was exactly that, half
shipped and half open. A partly-done issue gets rewritten to the remainder,
not closed.

For `subsumed` candidates: open the tracking issue and confirm it genuinely
covers this one. If it does, close with a pointer; if it merely mentions it,
it is not subsumed.

For `no-discussion` — the 40 enhancements nobody ever commented on — read each
one briefly and ask **the only question that matters: is anyone going to build
this?** The house rule is 37signals: no standing backlog of someday-ideas,
because what matters comes back on its own when it hurts. So default to
closing, and lift out the few that carry real substance — a concrete defect, a
decision already made, a contract that needs the number. Do not deep-verify
this bucket; that is the expensive mistake. Skim, lift out the keepers, close
the rest as a block.

## Step 3 — Act, by evidence class

Approval is **per class, never per issue** — 148 individual confirmations is
not a review, it is a rubber stamp. Present the user with grouped decisions:

> "38 verified done (merged PR + symbol present in main) — close?"
> "6 partly done — rewrite to the remainder?"
> "34 of 40 enhancements with no substance — close as out of scope?"

Show the lifted-out keepers by name and let the user veto individually there,
because that list is short.

Closing comments name the evidence: the PR that did it, or the tracking issue
that covers it. A closure nobody can audit later is a deletion.

## The one prohibition

`unanswered-sweep` in `.github/workflows/issue-triage.yml` goes red while an
outside report sits unanswered, and **only a maintainer comment clears it** —
no label, no assignee, no snooze. A triage pass that posts a friendly comment
under the user's account would silence that alarm without anyone having
answered.

So: **never comment on an issue the sweep flags `⚠ external, unanswered`.**
Closing it with a reason is allowed — the policy names that as the honest
alternative — and needs explicit approval each time.

## The invariant that makes next week cheap

**When the pass ends, every open issue carries a category label and no
`triage`.** That is what makes `untriaged` a trustworthy filter next week: no
state file, no date marker, no database — the labels are the state.

Label from the existing set (`gh label list`); do not invent new ones. Note
that `triage` and `external` are process markers, not categories — the sweep
already treats them as "nobody looked yet", which is why an incoming report
cannot hide behind a label its own arrival created.

## What this skill does not do

- **No staleness rule.** Measured, found useless here. See the table above.
- **No auto-close.** Every closure is approved, by class.
- **No new issues.** Triage removes; if something surfaces that deserves an
  issue, apply the usual bar — real intent to build, a silent correctness
  defect, or a process contract that needs the number.
- **No label invention.** The sweep reads existing labels; a new label is a
  decision for the user, not a side effect of triage.

## Changing the rules

Bucket logic lives in `scripts/lib/triage-sweep.mjs` and is covered by
`scripts/lib/triage-sweep.test.mjs` (`pnpm test:scripts`). Add a rule with a
test — the failure mode of every one of these classifiers is a silently
shorter list, which reads as a clean tracker.
