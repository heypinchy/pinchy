import type { Session } from "@/lib/auth";

/**
 * A fully-shaped Better Auth session for tests.
 *
 * `auth.api.getSession` and the `getSession` wrapper both resolve to the full
 * `{ session, user }` object (admin-plugin fields included). Hand-rolled
 * `{ user: {...} }` fixtures drift from that type the moment Better Auth or the
 * admin plugin adds a field — which is exactly how these mocks silently rotted
 * until the test-typecheck gate was turned on. Build session fixtures here so
 * the shape lives in one place and the compiler enforces completeness (the
 * `: Session` annotation on `base` fails to compile if a required field is
 * missing, so a Better Auth upgrade is a one-line fix here, not across 100
 * test files).
 *
 * Defaults to an admin user; override `user.role` for member-path tests.
 */
export function mockSession(
  overrides: {
    user?: Partial<Session["user"]>;
    session?: Partial<Session["session"]>;
  } = {}
): Session {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const base: Session = {
    session: {
      id: "session-1",
      createdAt: now,
      updatedAt: now,
      userId: "user-1",
      expiresAt: new Date("2026-01-08T00:00:00.000Z"),
      token: "test-session-token",
      ipAddress: null,
      userAgent: null,
      impersonatedBy: null,
    },
    user: {
      id: "user-1",
      createdAt: now,
      updatedAt: now,
      email: "admin@test.com",
      emailVerified: true,
      name: "Test Admin",
      image: null,
      context: null,
      banned: false,
      role: "admin",
      banReason: null,
      banExpires: null,
    },
  };
  return {
    session: { ...base.session, ...overrides.session },
    user: { ...base.user, ...overrides.user },
  };
}
