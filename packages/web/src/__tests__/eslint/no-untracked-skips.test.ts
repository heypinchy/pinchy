import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-untracked-skips.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-untracked-skips", rule, {
  valid: [
    // Issue ref in the comment block directly above the skip
    {
      code: `// tracked in #427\ntest.skip("foo", () => {});`,
      filename: "/e2e/foo.spec.ts",
    },
    // Issue ref via full GitHub URL
    {
      code: `// see https://github.com/heypinchy/pinchy/issues/123\nit.skip("bar", () => {});`,
      filename: "/spec/bar.test.ts",
    },
    // Issue ref a few lines above (e.g. above an enclosing describe)
    {
      code: `// (tracked in #99)\ndescribe("group", () => {\n  test.skip("a", () => {});\n});`,
      filename: "/x.test.ts",
    },
    // Block comment is fine
    {
      code: `/** Tracked in #1234. */\ndescribe.skip("group", () => {});`,
      filename: "/x.test.ts",
    },
    // Conditional skipIf is always allowed
    {
      code: `describe.skipIf(!process.env.RUN)("integration", () => {});`,
      filename: "/x.test.ts",
    },
    // Chained `test.describe.skip` with tracking comment
    {
      code: `// tracked in #427\ntest.describe.skip("group", () => {});`,
      filename: "/e2e/x.spec.ts",
    },
    // Non-skip calls aren't reported
    {
      code: `test("foo", () => {});\nit("bar", () => {});\ndescribe("baz", () => {});`,
      filename: "/x.test.ts",
    },
  ],
  invalid: [
    // Plain skip, no comment
    {
      code: `test.skip("foo", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // Skip with comment but no issue number
    {
      code: `// TODO: come back to this later\ntest.skip("foo", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // it.todo without a tracking issue
    {
      code: `it.todo("implement me");`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // describe.fixme
    {
      code: `describe.fixme("broken", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // Bare xit
    {
      code: `xit("foo", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // Bare xdescribe
    {
      code: `xdescribe("group", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // Chained test.describe.skip without comment
    {
      code: `test.describe.skip("group", () => {});`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
    // Issue ref too far away (>40 lines)
    {
      code:
        `// tracked in #99\n` +
        Array.from({ length: 45 }, () => "// filler").join("\n") +
        `\ntest.skip("foo", () => {});`,
      filename: "/x.test.ts",
      errors: [{ messageId: "untrackedSkip" }],
    },
  ],
});
