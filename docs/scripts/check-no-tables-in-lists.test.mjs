import { test } from "node:test";
import assert from "node:assert/strict";
import { checkContent } from "./check-no-tables-in-lists.mjs";

test("top-level table passes", () => {
  const content = `
| Col | Value |
| --- | ----- |
| a   | b     |
`.trim();
  assert.deepEqual(checkContent(content), []);
});

test("table indented inside a list item fails", () => {
  const content = `
1. Add these permissions:

   | Permission | Required for |
   | ---------- | ------------ |
   | \`Mail.Send\` | Send emails |
`.trim();
  const violations = checkContent(content);
  assert.ok(violations.length > 0, "expected violations");
  assert.equal(violations[0].lineNumber, 3);
});

test("table inside fenced code block passes", () => {
  const content = `
\`\`\`
   | not | a | real | table |
\`\`\`
`.trim();
  assert.deepEqual(checkContent(content), []);
});

test("indented code block inside list with pipe passes", () => {
  const content = `
- item

  \`\`\`js
  const x = "| a | b |";
  \`\`\`
`.trim();
  assert.deepEqual(checkContent(content), []);
});

test("frontmatter with pipe characters passes", () => {
  const content = `---
title: Connect Email (Microsoft 365)
description: Connect a Microsoft 365 work | school account.
---

Normal paragraph.
`.trim();
  assert.deepEqual(checkContent(content), []);
});

test("table inside Steps component (indented) fails", () => {
  const content = `
<Steps>
4. Check operations:

    | Permission | What it enables |
    | ---------- | --------------- |
    | Read       | List emails     |

5. Click Save
</Steps>
`.trim();
  const violations = checkContent(content);
  assert.ok(violations.length > 0, "expected violations inside Steps");
});
