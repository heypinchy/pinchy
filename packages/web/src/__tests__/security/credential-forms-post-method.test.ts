import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Tripwire (text-scan) security test: every credential-carrying <form> must
 * declare method="post".
 *
 * Root cause this guards against: these forms are React client components
 * using react-hook-form (`<form onSubmit={form.handleSubmit(onSubmit)}>`).
 * react-hook-form's handler only calls preventDefault() once JS has
 * hydrated. Without an explicit `method` attribute, a *native* pre-hydration
 * submit (slow hydration, hydration failure, no-JS) defaults to GET and
 * serializes named inputs — including passwords and API keys — into the
 * URL, browser history, server access logs, and Referer headers.
 * `method="post"` makes a native pre-hydration submit a POST (secret stays
 * in the request body) without changing the normal hydrated flow, where
 * react-hook-form still preventDefault()s and drives submission through the
 * API client.
 *
 * Covered files (every <form> in each must have method="post"):
 * - src/app/login/page.tsx
 * - src/app/invite/[token]/page.tsx
 * - src/components/setup-form.tsx
 * - src/components/settings-profile.tsx
 * - src/components/add-integration-dialog.tsx
 * - src/components/edit-credentials-dialog.tsx
 */

const CREDENTIAL_FORM_FILES = [
  "src/app/login/page.tsx",
  "src/app/invite/[token]/page.tsx",
  "src/components/setup-form.tsx",
  "src/components/settings-profile.tsx",
  "src/components/add-integration-dialog.tsx",
  "src/components/edit-credentials-dialog.tsx",
];

const webRoot = path.resolve(__dirname, "../../..");

// Matches a full opening <form ...> tag, allowing attributes/newlines
// between "<form" and the closing ">".
const FORM_OPEN_TAG_RE = /<form\b[^>]*>/gs;

describe('Credential forms use method="post"', () => {
  for (const relativePath of CREDENTIAL_FORM_FILES) {
    it(`every <form> in ${relativePath} has method="post"`, () => {
      const source = readFileSync(path.join(webRoot, relativePath), "utf8");
      const formTags = source.match(FORM_OPEN_TAG_RE) ?? [];

      expect(formTags.length, `Expected at least one <form> in ${relativePath}`).toBeGreaterThan(0);

      for (const tag of formTags) {
        expect(tag, `<form> in ${relativePath} is missing method="post": ${tag}`).toMatch(
          /method="post"/
        );
      }
    });
  }
});
