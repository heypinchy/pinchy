// ESLint rule: forbid permanent test skips (`.skip`, `.todo`, `.fixme`,
// `xit`, `xdescribe`) unless the immediately surrounding context references
// a tracking issue (`#NNN` or a GitHub issue URL).
//
// Conditional gates (`.skipIf(...)`) are allowed: they're driven by runtime
// signals (env vars, OS features), not by "we'll come back to this later"
// rationalisations.
//
// Companion to the vitest drift-guard at
// packages/web/src/__tests__/lib/no-untracked-skips.test.ts — the lint rule
// catches the same problem at edit time, before the file lands in git.
//
// Background: the 2026-05-22 audit found five separate skip clusters that
// all followed the same pattern (quick fix → honest "tracked separately"
// comment → no issue actually filed → forgotten). One of them hid a
// production-breaking password-reset bug for weeks.

const ISSUE_REF_RE = /#\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+/;
const SKIP_MEMBERS = new Set(["skip", "todo", "fixme"]);
const SKIP_BARE_NAMES = new Set(["xit", "xdescribe"]);
const TEST_OBJECTS = new Set(["test", "it", "describe"]);

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid test.skip / it.skip / describe.skip / .todo / .fixme / xit / xdescribe unless the leading comments reference a tracking issue (#NNN)",
    },
    messages: {
      untrackedSkip:
        '{{call}} needs a tracking issue. Add a comment with `#<issue-number>` (or the issue URL) above the call, or remove the skip. See AGENTS.md § "No untracked test skips".',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    /**
     * The leading-comment scan tolerates a comment block that's a few lines
     * above the skip (e.g. above the surrounding describe). We scan all
     * comments in the file and accept any whose range ends within 40 lines
     * before the skip call.
     */
    function hasNearbyIssueRef(node) {
      const skipLine = node.loc.start.line;
      const comments = sourceCode.getAllComments();
      for (const comment of comments) {
        if (comment.loc.end.line >= skipLine) continue;
        if (skipLine - comment.loc.end.line > 40) continue;
        if (ISSUE_REF_RE.test(comment.value)) return true;
      }
      return false;
    }

    function report(node, callDescription) {
      if (hasNearbyIssueRef(node)) return;
      context.report({
        node,
        messageId: "untrackedSkip",
        data: { call: callDescription },
      });
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // Pattern 1: `test.skip(...)`, `it.todo(...)`, `describe.fixme(...)`
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.property.type === "Identifier" &&
          TEST_OBJECTS.has(callee.object.name) &&
          SKIP_MEMBERS.has(callee.property.name)
        ) {
          report(node, `${callee.object.name}.${callee.property.name}(...)`);
          return;
        }

        // Pattern 2: `test.describe.skip(...)` — chained member.
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          SKIP_MEMBERS.has(callee.property.name) &&
          callee.object.type === "MemberExpression" &&
          !callee.object.computed &&
          callee.object.object.type === "Identifier" &&
          callee.object.property.type === "Identifier" &&
          TEST_OBJECTS.has(callee.object.object.name)
        ) {
          const desc = `${callee.object.object.name}.${callee.object.property.name}.${callee.property.name}(...)`;
          report(node, desc);
          return;
        }

        // Pattern 3: bare `xit(...)` / `xdescribe(...)`
        if (callee.type === "Identifier" && SKIP_BARE_NAMES.has(callee.name)) {
          report(node, `${callee.name}(...)`);
          return;
        }
      },
    };
  },
};
