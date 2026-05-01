import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { verifyPassword as verifyScrypt } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { getCachedDomain } from "@/lib/domain";

/**
 * After-hook middleware for audit trail logging.
 *
 * Logs auth.login, auth.failed, and auth.logout events.
 * Exported separately so tests can verify the hook logic
 * without instantiating the full Better Auth server.
 */
export const auditAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-in/email") {
    const email = (ctx.body as { email?: string })?.email ?? "unknown";
    const newSession = ctx.context.newSession;

    if (newSession) {
      // Successful login
      try {
        await appendAuditLog({
          actorType: "user",
          actorId: newSession.user.id,
          eventType: "auth.login",
          detail: { email },
          outcome: "success",
        });
      } catch {
        // Don't break auth if audit logging fails
      }
    } else {
      // Failed login attempt
      try {
        await appendAuditLog({
          actorType: "system",
          actorId: "system",
          eventType: "auth.failed",
          detail: { email, reason: "invalid_credentials" },
          outcome: "failure",
          error: { message: "Invalid credentials" },
        });
      } catch {
        // Don't break auth if audit logging fails
      }
    }
  }

  if (ctx.path === "/sign-out") {
    const session = ctx.context.session;
    if (session?.user?.id) {
      try {
        await appendAuditLog({
          actorType: "user",
          actorId: session.user.id,
          eventType: "auth.logout",
          detail: {},
          outcome: "success",
        });
      } catch {
        // Don't break auth if audit logging fails
      }
    }
  }
});

/**
 * Decide whether to override Better Auth's default rate limiting.
 *
 * Default: returns `undefined` so Better Auth uses its own behaviour
 * (`enabled: NODE_ENV === "production"`, with a /sign-in/* limit of
 * 3 req / 10s per IP).
 *
 * `PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT=1` disables it. We set this in
 * `docker-compose.e2e.yml` so Playwright form-login flows can exercise
 * the production image without the test runner locking itself out
 * after a few `loginViaUI` calls. Production deployments never set
 * this env var, and `auth-config-consistency.test.ts` blocks anyone
 * from accidentally adding it to `docker-compose.yml`.
 *
 * Evaluated once at module load (when `auth` is constructed). Changing
 * the env var at runtime has no effect on the live `auth` instance —
 * the container restarts whenever the value changes, which is fine
 * because Docker injects env at process start.
 */
export function getAuthRateLimitConfig(): { enabled: false } | undefined {
  if (process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT === "1") {
    return { enabled: false };
  }
  return undefined;
}

export const auth = betterAuth({
  rateLimit: getAuthRateLimitConfig(),
  trustedOrigins: (request) => {
    const domain = getCachedDomain();
    if (domain) {
      // Domain is locked — only trust the locked domain over HTTPS
      return [`https://${domain}`];
    }
    // No domain locked — trust the origin from the request (self-hosted trust model).
    // This allows login to work whether accessed via IP, localhost, or custom domain.
    const host = request?.headers?.get("x-forwarded-host") ?? request?.headers?.get("host");
    const proto = request?.headers?.get("x-forwarded-proto") ?? "http";
    return host ? [`${proto}://${host}`] : [];
  },
  advanced: {
    // When a domain is cached, HTTPS is expected — enable Secure cookies.
    // Without HTTPS, cookies must not have the Secure flag or browsers will reject them.
    useSecureCookies: getCachedDomain() !== null,
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
    },
  }),
  emailAndPassword: {
    enabled: true,
    password: {
      // Accept legacy bcrypt hashes from pre-migration users
      verify: async ({ password, hash }) => {
        if (hash.startsWith("$2")) {
          return bcrypt.compare(password, hash);
        }
        // Fall through to Better Auth's default scrypt verifier
        return verifyScrypt({ password, hash });
      },
    },
  },
  user: {
    additionalFields: {
      context: {
        type: "string",
        required: false,
      },
    },
  },
  plugins: [
    admin({
      defaultRole: "member",
    }),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
  },
  hooks: {
    after: auditAfterHook,
  },
});

// Since Better Auth 1.5.6 the admin plugin fields (role, banned, banReason,
// banExpires) ARE inferred on $Infer.Session["user"], but as optional
// (string | null | undefined). Because Pinchy always runs the admin plugin,
// we narrow them to required non-undefined here so call sites can pass
// `session.user.role` directly into helpers expecting `string`.
type InferredSession = typeof auth.$Infer.Session;
export type Session = {
  session: InferredSession["session"];
  user: InferredSession["user"] & {
    role: string;
    banned: boolean;
    banReason: string | null;
    banExpires: Date | null;
  };
};

/**
 * Typed wrapper around auth.api.getSession that includes admin plugin fields.
 */
export async function getSession(opts: { headers: Headers }): Promise<Session | null> {
  const session = await auth.api.getSession(opts);
  return session as Session | null;
}
