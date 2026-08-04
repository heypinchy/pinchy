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
// IMPORTANT: when adding a new skip syntax (e.g. a future `suite.skip` from
// Vitest 5), update BOTH this rule AND the drift-guard regexes. The parity
// test at packages/web/src/__tests__/lib/no-untracked-skips-parity.test.ts
// pins them together — it feeds the same fixtures through both and asserts
// matching verdicts, so if you only update one, CI will tell you.
//
// A skip must be CALLED, not aliased. `const d = cond ? describe : describe.skip`
// and the plain `const d = describe.skip` both put the skip behind an
// identifier, and every checker here — plus the drift-guard's text scan —
// matches the call form only. So the alias form was invisible to both, which
// is how two of them sat in the tree until #1071 rewrote them by hand. The
// unconditional `const d = describe.skip` is the case that matters: a permanent,
// untracked skip that no guard could see. Aliases are reported separately
// (`aliasedSkip`) because the fix differs — a conditional gate wants
// `describe.skipIf(cond)`, not an issue number.
//
// Known false-negative windows, both documented rather than closed:
//   - The leading-comment scan reaches 40 lines above the skip call. An
//     unrelated `#NNN` inside that window will pass the check.
//   - Aliasing the test object instead of the skip (`const d = describe;`
//     then `d.skip(...)`) needs scope analysis to follow and is not reported.
// A code review owns both.
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
      aliasedSkip:
        '{{call}} is referenced instead of called, which hides it from both skip guards (they match the call form). For a conditional gate use `{{object}}.skipIf(<condition>)`; for a permanent skip call it directly with a `#<issue-number>` comment. See AGENTS.md § "No untracked test skips".',
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

    /**
     * Describe a skip member expression, or return null if the node isn't one.
     *
     * Two accepted shapes:
     *   - `test.skip` / `it.todo` / `describe.fixme`  (object is an Identifier)
     *   - `test.describe.skip`                        (chained member)
     *
     * `describe.skipIf` is deliberately not one of them: `skipIf` isn't in
     * SKIP_MEMBERS, so a conditional gate never reaches this function.
     */
    function skipMember(node) {
      if (node.type !== "MemberExpression" || node.computed) return null;
      if (node.property.type !== "Identifier") return null;
      if (!SKIP_MEMBERS.has(node.property.name)) return null;

      // Shape 1: `describe.skip`
      if (node.object.type === "Identifier" && TEST_OBJECTS.has(node.object.name)) {
        return { path: `${node.object.name}.${node.property.name}`, object: node.object.name };
      }

      // Shape 2: `test.describe.skip`
      const obj = node.object;
      if (
        obj.type === "MemberExpression" &&
        !obj.computed &&
        obj.object.type === "Identifier" &&
        obj.property.type === "Identifier" &&
        TEST_OBJECTS.has(obj.object.name)
      ) {
        const objectPath = `${obj.object.name}.${obj.property.name}`;
        return { path: `${objectPath}.${node.property.name}`, object: objectPath };
      }

      return null;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // Patterns 1 & 2: `test.skip(...)`, `it.todo(...)`, `describe.fixme(...)`
        // and the chained `test.describe.skip(...)`.
        const member = skipMember(callee);
        if (member) {
          report(node, `${member.path}(...)`);
          return;
        }

        // Pattern 3: bare `xit(...)` / `xdescribe(...)`
        if (callee.type === "Identifier" && SKIP_BARE_NAMES.has(callee.name)) {
          report(node, `${callee.name}(...)`);
          return;
        }
      },

      // Pattern 4: a skip that is referenced rather than called.
      //
      //   const d = cond ? describe : describe.skip;   // conditional gate
      //   const d = describe.skip;                     // permanent skip, hidden
      //   test.skip.each([...])("name", fn)            // chained off the skip
      //
      // The CallExpression visitor above sees none of these, because in all
      // three the skip member is not the thing being called.
      MemberExpression(node) {
        const member = skipMember(node);
        if (!member) return;

        const parent = node.parent;

        // `describe.skip(...)` — the CallExpression visitor owns this one.
        if (parent && parent.type === "CallExpression" && parent.callee === node) return;

        // `test.skip.each([...])(...)` — still a skip being invoked, just
        // through a chain. Report it as the skip it is, not as an alias.
        if (parent && parent.type === "MemberExpression" && parent.object === node) {
          report(node, `${member.path}(...)`);
          return;
        }

        if (hasNearbyIssueRef(node)) return;
        context.report({
          node,
          messageId: "aliasedSkip",
          data: { call: member.path, object: member.object },
        });
      },
    };
  },
};
