// ESLint rule: forbid `waitForTimeout(...)` — a fixed sleep — in Playwright
// specs unless the immediately surrounding context references a tracking issue
// (`#NNN` or a GitHub issue URL).
//
// Why: every Playwright config in this repo pins `retries: 0, workers: 1`
// deliberately, so a flake is a real signal rather than something a rerun
// papers over. A fixed sleep quietly trades that away: it is green on a fast
// host and red on a loaded CI runner, and the failure it produces says
// "timeout" rather than naming the thing that was actually slow. Playwright's
// web-first assertions (`expect(...).toBeVisible()`, `expect.poll(...)`,
// `page.waitForURL`, `waitForResponse`) retry against a real signal and report
// what they were waiting for — they are the fix in almost every case.
//
// The exemption is deliberately the SAME contract as the skip policy (see
// eslint-rules/no-untracked-skips.js and AGENTS.md § "No Untracked Test
// Skips"): a sleep is allowed when an issue is on the hook for removing it.
// The honest case is a bounded NEGATIVE window — proving that further tokens
// never arrive, or that no error boundary engaged — for which no `waitFor`
// exists, because there is no event to wait for. That case still needs an
// issue, because the deterministic replacement (a signal from the mock that
// the stream ended) is real work someone should eventually do, not a fact of
// nature.
//
// Scope limit, stated plainly: this rule bans the Playwright API, not the
// concept. `await new Promise((r) => setTimeout(r, 500))` is the same sleep
// and is NOT reported — banning it would sweep up ~85 poll-loop intervals
// across the e2e tree, which is a separate change with a separate argument.
// So this is a tripwire against the API a developer reaches for by reflex,
// not a proof that the suite contains no sleeps. Writing the setTimeout form
// to dodge this rule is a deliberate act, and review owns that case.
//
// The scan is narrower than no-untracked-skips' 40-line window on purpose. A
// skip's justification legitimately sits above the enclosing `describe`; a
// sleep's does not — it is one statement and its reason belongs on it. The
// wide window also does not work here: a 40-line scan over the two sleeps this
// rule was written for found `request #2` and `openclaw#42172` in unrelated
// comments and waved both through. So the exemption must be in the comment
// block directly above the statement, with no code in between.

const ISSUE_REF_RE = /#\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+/;
const SLEEP_METHOD = "waitForTimeout";

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid page.waitForTimeout (fixed sleeps) in Playwright specs unless the leading comments reference a tracking issue (#NNN)",
    },
    messages: {
      untrackedSleep:
        '{{call}} is a fixed sleep: green on a fast host, flaky on a loaded runner. Wait on a real signal instead — a web-first assertion, `expect.poll(...)`, `page.waitForURL(...)`, `page.waitForResponse(...)`. If the sleep bounds a NEGATIVE window that has no signal to wait for, file an issue and put `#<issue-number>` in a comment above the call. See AGENTS.md § "No Untracked Sleeps In E2E".',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    /**
     * The comments attached directly above the sleep's own statement — i.e.
     * everything between the previous token and this one. Any code in between
     * ends the block, which is what keeps an unrelated `#NNN` further up the
     * test from clearing the sleep.
     */
    function hasLeadingIssueRef(node) {
      let statement = node;
      while (statement.parent && !/Statement|Declaration/.test(statement.type)) {
        statement = statement.parent;
      }
      return sourceCode
        .getCommentsBefore(statement)
        .some((comment) => ISSUE_REF_RE.test(comment.value));
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;

        // `page.waitForTimeout(...)` — and `page["waitForTimeout"](...)`, so a
        // computed access is not a loophole.
        const isSleep = callee.computed
          ? callee.property.type === "Literal" && callee.property.value === SLEEP_METHOD
          : callee.property.type === "Identifier" && callee.property.name === SLEEP_METHOD;
        if (!isSleep) return;

        // The receiver is usually `page`, but frames, popups and fixtures all
        // expose the same method — report on the method, whatever it hangs off.
        const receiver = callee.object.type === "Identifier" ? callee.object.name : "…";
        if (hasLeadingIssueRef(node)) return;
        context.report({
          node,
          messageId: "untrackedSleep",
          data: { call: `${receiver}.${SLEEP_METHOD}(...)` },
        });
      },
    };
  },
};
