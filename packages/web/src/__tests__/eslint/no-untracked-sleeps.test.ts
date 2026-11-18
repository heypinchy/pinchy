import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-untracked-sleeps.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-untracked-sleeps", rule, {
  valid: [
    // Issue ref in the comment block directly above the sleep
    {
      code: `// The absence of further tokens has no waitFor — tracked in #123\nawait page.waitForTimeout(500);`,
      filename: "/e2e/foo.spec.ts",
    },
    // Issue ref via full GitHub URL
    {
      code: `// see https://github.com/heypinchy/pinchy/issues/123\nawait page.waitForTimeout(500);`,
      filename: "/e2e/bar.spec.ts",
    },
    // A multi-line block directly above the sleep is one block: the ref may sit
    // on any of its lines.
    {
      code: `test("a", async ({ page }) => {\n  await setUp();\n  // No event marks "no further tokens arrived".\n  // Tracked in #99.\n  await page.waitForTimeout(200);\n});`,
      filename: "/e2e/x.spec.ts",
    },
    // Block comment is fine
    {
      code: `/** Bounded negative window. Tracked in #1234. */\nawait page.waitForTimeout(1000);`,
      filename: "/e2e/x.spec.ts",
    },
    // Any receiver is covered, and an issue ref clears it
    {
      code: `// tracked in #7\nawait frame.waitForTimeout(50);`,
      filename: "/e2e/x.spec.ts",
    },
    // Deterministic waits are the point — never reported
    {
      code: `await page.waitForSelector(".x");\nawait expect.poll(() => n).toBeGreaterThan(1);\nawait page.waitForURL("/chat");`,
      filename: "/e2e/x.spec.ts",
    },
    // A property named waitForTimeout that is not called is not a sleep
    {
      code: `const fn = page.waitForTimeout;`,
      filename: "/e2e/x.spec.ts",
    },
  ],
  invalid: [
    // Plain sleep, no comment
    {
      code: `await page.waitForTimeout(500);`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
    // Comment without an issue number is not an exemption
    {
      code: `// give the UI a moment to settle\nawait page.waitForTimeout(500);`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
    // Non-`page` receivers are covered too
    {
      code: `await frame.waitForTimeout(200);`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
    // An issue ref separated from the sleep by code does not clear it. This is
    // the real shape both sleeps in the repo had: `request #2` and
    // `openclaw#42172` sat higher up in the same test and are about other
    // things entirely.
    {
      code: `// Wait for history request #2 to be delivered.\nawait expect.poll(fn).toBeGreaterThan(1);\n// A short, bounded settle.\nawait page.waitForTimeout(200);`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
    // A ref above the enclosing test does not reach into it either
    {
      code: `// tracked in #99\ntest("a", async ({ page }) => {\n  await setUp();\n  await page.waitForTimeout(200);\n});`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
    // Computed access does not evade the rule
    {
      code: `await page["waitForTimeout"](200);`,
      filename: "/e2e/x.spec.ts",
      errors: [{ messageId: "untrackedSleep" }],
    },
  ],
});
