import { z } from "zod";
import { isCommonPassword } from "@/lib/common-passwords";

/**
 * Minimum password length, in characters. Aligned with OWASP ASVS L2.
 *
 * If you change this, also update `emailAndPassword.password.minLength`
 * in `auth.ts` so Better Auth's own paths reject the same passwords,
 * and update the user-facing copy in setup-form, settings-profile, and
 * the invite page.
 */
export const PASSWORD_MIN_LENGTH = 12;

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
