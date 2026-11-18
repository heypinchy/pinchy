import { z } from "zod";
import { isCommonPassword } from "@/lib/common-passwords";

/**
 * Minimum password length, in characters. Aligned with OWASP ASVS L2.
 *
 * If you change this, also update `emailAndPassword.password.minLength`
 * in `auth.ts` so Better Auth's own paths reject the same passwords.
 * User-facing copy derives from it (`PASSWORD_RULE_HINT`, the error text).
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * The rule as a form shows it up front, before anyone has failed it (#1265).
 * Derived from the constant so the hint cannot fall behind a policy bump. The
 * breach-list check is not in it: it rejects a handful of passwords, and the
 * inline error names it when it does.
 */
export const PASSWORD_RULE_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`;

/**
 * Validates password strength. Returns an error message or null if valid.
 *
 * Single source of truth for the password policy — used by setup,
 * invite-claim (incl. admin-triggered reset), and self-service change
 * password. Better Auth's `password.minLength` is configured to match.
 */
export function validatePassword(password: string): string | null {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }

  if (isCommonPassword(password)) {
    return "Password is too common. Please choose a less predictable one.";
  }

  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain at least one letter and one number";
  }

  return null;
}

/**
 * Shared zod schema for password fields. Mirrors `validatePassword` so
 * forms surface the same errors inline (no API roundtrip needed) and a
 * future policy bump only has to change this file.
 */
export const passwordSchema = z.string().superRefine((val, ctx) => {
  const error = validatePassword(val);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
});
