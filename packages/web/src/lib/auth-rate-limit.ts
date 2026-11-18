/**
 * How long Better Auth throttles a client after too many sign-in attempts.
 *
 * This lives in its own module because both sides of the login flow need it:
 * `getAuthRateLimitConfig()` in `@/lib/auth` enforces the window, and the login
 * page tells the user how long to wait. `@/lib/auth` cannot be imported from a
 * client component — it pulls in the Drizzle adapter, bcrypt and the database —
 * so the one value they must agree on lives here instead of being typed out
 * twice and drifting apart.
 */
export const SIGN_IN_RATE_LIMIT_WINDOW_SECONDS = 60;
