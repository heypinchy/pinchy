/**
 * Shared CSV helpers for the audit-log and usage exports.
 *
 * Both exports surface attacker-influenceable text (a user display name, group
 * name, agent name, error string) into a CSV that a compliance admin opens in
 * Excel/Sheets. A cell whose first character is one of `= + - @ TAB CR` is
 * evaluated as a formula there (classic CSV / formula injection — e.g.
 * `=HYPERLINK(...)` exfiltrating data in the admin's context). RFC 4180 quoting
 * alone does NOT prevent evaluation, so we prefix such a value with a single
 * quote so the spreadsheet treats it as literal text.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Prefix a formula-triggering value with `'` so spreadsheets treat it as text. */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** RFC 4180 field that is always wrapped in double quotes (after neutralizing). */
export function csvField(value: string): string {
  const safe = neutralizeFormula(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * RFC 4180 field wrapped only when it contains a comma, quote, or newline.
 * The formula guard runs first and unconditionally — a `=...` value with no
 * comma must still be neutralized even though it would not otherwise be wrapped.
 */
export function csvEscape(value: string): string {
  const safe = neutralizeFormula(value);
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
