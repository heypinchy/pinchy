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

The first full sweep ran on 2026-08-01 and took the backlog from **148 to 97**:
18 closed against verified evidence, 32 closed as out-of-scope, 5 rewritten to
their remainder. What it measured about its own heuristics matters more than
the count, and is why Step 2 exists in the shape it does:

| Bucket          | Candidates | Actually settled |
| --------------- | ---------- | ---------------- |
| `closed-by-pr`  | 54         | **16**           |
| `subsumed`      | 6          | **0**            |
| `no-discussion` | 40         | 34               |

**A merge cross-reference is weak evidence — it was right 30% of the time.**
Three that would have been closed by anything that trusts the link: #164
(pairing race) pointed at a Brave-Search PR; #602 (build a governed browser
tool) pointed at PR #603, _"**deny** OpenClaw group:ui so the native browser
tool isn't silently reachable"_ — the opposite act; and #849, an outside bug
report, pointed at _"Never let an outside bug report wait unseen"_, the process
fix that report caused rather than the fix it asked for.

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
mkdir -p docs/plans && node scripts/triage-sweep.mjs > docs/plans/triage-$(date +%F).md
```

`docs/plans/` is gitignored, so it does not exist in a fresh checkout and the
redirect alone would fail before the sweep ever ran.

One GraphQL pass, a few seconds, no writes to GitHub. It sorts every open issue
into a bucket by evidence and prints markdown. It borrows credentials from
`gh`, so `gh auth login` must have happened.

Each line can carry two flags in brackets, and both cut across the buckets
rather than replacing them:

- `⚠ external, unanswered` — an outside reporter is owed a reply. See the
  prohibition below; this one governs what you may not do.
- `never discussed` — nobody has ever commented. Not a verdict either, but it
  is the question the pass must ask before labelling anything.

**Write it to a file and keep the verdicts there as you go.** A full sweep is
54 candidates times three checks; that outlives a context window, and
re-verifying from scratch after a compaction is the difference between a pass
that finishes and one that gets abandoned half-done. The working file never
lands in a commit.

**The sweep never reaches a verdict.** It reports that #465 has a merged PR in
its timeline; it does not report that #465 is done. Of the 54 in
`closed-by-pr`, some are tracking issues that legitimately accumulate merged
PRs for months — #543 and #669 both look exactly like a zombie and both are
alive. Treat the bucket as a candidate list.

## Step 2 — Verify, per candidate

This is the actual work, and it is the reason this is a skill and not a cron
job.

**Gather in bulk first, then judge.** 54 candidates checked one at a time will
not survive a context window. Two loops — issue titles/bodies/labels, then the
titles of every referenced PR — turn the whole bucket into two files you can
read straight through. Do that before opening anything individually.

Then, per `closed-by-pr` candidate, in this order, stopping as soon as one
check settles it:

1. **Read the PR's title.** The cheapest decisive signal by a wide margin, and
   you already have all of them from the bulk pass. Two shapes settle
   immediately:
   - **A title carrying the issue's own number** is strong evidence _for_
     completion — "strip MEMORY.md from group-session bootstrap (#369)" and
     "make the Layer-3 groundedness sweep actually run (#869)" were both real.
   - **A title about something else entirely** is the passing mention, and it
     is the common case. Move on; do not open the diff.
2. **Grep `main` for the thing the issue names.** The symbol, the file, the
   flag. `git grep -n <symbol> origin/main -- <path>`. An issue asking for a
   function that now exists is done; an issue asking for behaviour is not
   settled by a grep, and needs the PR read.
3. **Check for unlanded work.** `git branch -a` and `git worktree list`, by
   issue number _and_ by keyword. Finished-but-never-pushed branches sit
   around here regularly. That is not "done", it is "started".

Watch for the **inverted** PR — one that _restricts_ what the issue asked to
build. #603 denied access to the browser tool #602 wanted governed. A title
match on the topic is not a match on the direction.

Three verdicts, and **"partly" is a real one** — 5 of 54 were, and #755 is the
instructive one: the workspace-retrofit half shipped while the reported core
(memory gated on a grant no template hands out) stood untouched. A partly-done
issue gets rewritten to the remainder, not closed.

For `subsumed` candidates: open the tracking issue and confirm it genuinely
covers this one. **All 6 failed this test on the first sweep, so expect to
close none of them.** The distinction that matters: #556 says outright _"this
is the umbrella so the individual findings stay connected — pick work off the
table below."_ An umbrella that **indexes** work does not **replace** it, and
closing its rows deletes the only place the work is written down. Subsumption
means the tracking issue's own body carries the scope — as #543's title does,
naming exactly which three RFCs it consolidated.

For `no-discussion` — enhancements nobody ever commented on — read each one
briefly and ask **the only question that matters: is anyone going to build
this?** The house rule is 37signals: no standing backlog of someday-ideas,
because what matters comes back on its own when it hurts. So default to
closing, and lift out the few that carry real substance — a concrete defect, a
decision already made, a contract that needs the number. Do not deep-verify
this bucket; that is the expensive mistake. Skim, lift out the keepers, close
the rest as a block.

**Ask that same question of every `[never discussed]` entry, in whatever bucket
it appears — not just this one.** The buckets are exclusive and `untriaged`
outranks `no-discussion`, so an unlabeled enhancement nobody commented on shows
up only as untriaged. Label it to satisfy the invariant below and it silently
becomes a `no-discussion` entry — which next week's report offers up as a
fresh default-close candidate that nobody has actually read. The first sweep
did this to 19 issues in an afternoon, and only noticed because the counts
moved. The flag exists so the question gets asked once, in the pass that is
already looking.

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

**Comment on the keepers too, saying why.** Same reason, one level up: an issue
kept against the 37signals default has had a decision made about it, and a
decision with no trace gets re-litigated from scratch next sweep — or worse,
goes the other way. The comment is also what moves it out of the comment-less
set, so the record and the classifier agree instead of drifting.

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
