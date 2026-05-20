import { sanitizeDetail } from "@/lib/audit-sanitize";

/**
 * Sanitizes the diagnostics bundle by delegating to `sanitizeDetail`, which
 * applies both inline secret-pattern redaction (sk-ant-*, ghp_*, Bearer *, …)
 * and sensitive-key redaction (any object key containing "password", "token",
 * "apikey", "authorization", "credential", …) with a depth guard. Diagnostics
 * bundles can carry arbitrary tool output where credentials may surface in
 * either form, so the stronger redactor is the right default.
 */
export function sanitizeBundle<T>(input: T): T {
  return sanitizeDetail(input);
}
