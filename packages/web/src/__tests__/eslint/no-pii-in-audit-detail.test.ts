import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/no-pii-in-audit-detail.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-pii-in-audit-detail", rule, {
  valid: [
    // Spreading redactEmail() is the canonical way to identify an address.
    {
      code: `appendAuditLog({ eventType: "auth.login", detail: { ...redactEmail(email) } });`,
    },
    {
      code: `appendAuditLog({ eventType: "user.invited", detail: { ...redactEmail(email), role: "member" } });`,
    },
    // Detail without any email-shaped key is fine.
    {
      code: `appendAuditLog({ eventType: "agent.created", detail: { name: "Smithers" } });`,
    },
    // Hash + preview written explicitly (e.g. by the helper) is fine.
    {
      code: `appendAuditLog({ eventType: "auth.login", detail: { emailHash: h, emailPreview: p } });`,
    },
    // Plain `email` outside an audit call is unrelated.
    {
      code: `const payload = { email: user.email };`,
    },
    // Email as a *value* (not a key) is fine — only the key matters here.
    {
      code: `appendAuditLog({ eventType: "user.updated", detail: { changes: { email: { from: a, to: b } } } });`,
    },
  ],
  invalid: [
    {
      code: `appendAuditLog({ eventType: "user.deleted", detail: { name: "x", email: deactivated.email } });`,
      errors: [{ messageId: "noPlaintextEmail" }],
    },
    {
      code: `appendAuditLog({ eventType: "auth.login", detail: { email } });`,
      errors: [{ messageId: "noPlaintextEmail" }],
    },
    {
      code: `appendAuditLog({ eventType: "config.changed", detail: { type: "google", emailAddress } });`,
      errors: [{ messageId: "noPlaintextEmail" }],
    },
    // Even with redactEmail spread, an additional `email:` key is suspicious — flag it.
    {
      code: `appendAuditLog({ eventType: "auth.login", detail: { ...redactEmail(email), email } });`,
      errors: [{ messageId: "noPlaintextEmail" }],
    },
  ],
});
