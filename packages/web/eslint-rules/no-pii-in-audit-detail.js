/**
 * Forbid plaintext email keys (`email`, `emailAddress`) inside
 * `appendAuditLog({ ..., detail: { ... } })`. The audit log is HMAC-signed
 * and append-only — a raw email written into `detail` cannot be redacted
 * later without breaking row integrity, which conflicts with GDPR Art. 17.
 *
 * Use `redactEmail(email)` from `@/lib/audit` instead — it returns
 * `{ emailHash, emailPreview }` which are safe to log.
 *
 * Detection is purely structural and intentionally narrow:
 * - We only look at the `detail` property of the first argument to
 *   `appendAuditLog(...)`.
 * - We flag a `Property` whose key is `email` or `emailAddress` (literal
 *   identifier — not e.g. computed keys or `changes.email.from`).
 * - Spread elements (`...redactEmail(email)`) are allowed.
 */
/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid plaintext `email`/`emailAddress` keys in appendAuditLog detail (GDPR Art. 17 — use redactEmail() from @/lib/audit)",
    },
    messages: {
      noPlaintextEmail:
        "Do not write plaintext `{{key}}` into appendAuditLog `detail` — the row is HMAC-signed and cannot be redacted later (GDPR Art. 17). Use `...redactEmail(email)` from `@/lib/audit` instead.",
    },
    schema: [],
  },
  create(context) {
    const FORBIDDEN_KEYS = new Set(["email", "emailAddress"]);

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "appendAuditLog") {
          return;
        }
        const arg = node.arguments[0];
        if (!arg || arg.type !== "ObjectExpression") return;

        const detailProp = arg.properties.find(
          (p) =>
            p.type === "Property" &&
            !p.computed &&
            ((p.key.type === "Identifier" && p.key.name === "detail") ||
              (p.key.type === "Literal" && p.key.value === "detail"))
        );
        if (!detailProp || detailProp.value.type !== "ObjectExpression") return;

        for (const prop of detailProp.value.properties) {
          if (prop.type !== "Property" || prop.computed) continue;
          const keyName =
            prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal"
                ? prop.key.value
                : null;
          if (typeof keyName === "string" && FORBIDDEN_KEYS.has(keyName)) {
            context.report({
              node: prop,
              messageId: "noPlaintextEmail",
              data: { key: keyName },
            });
          }
        }
      },
    };
  },
};
