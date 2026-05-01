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
 * Hardened rate-limit config for Better Auth (see issue #239).
 *
 * Better Auth's defaults (3 req / 10s per IP on `/sign-in/*`) are too weak
 * for an enterprise target — 18 attempts/min × cheap residential proxy
 * pools defeats brute-force protection trivially. We set explicit values
 * here so a future Better Auth upgrade can't silently weaken us.
 *
 * `enabled` is left to Better Auth's own default: `NODE_ENV === "production"`
 * (off in dev/test). The E2E env-var disable below short-circuits this for
 * Playwright runs against the production image.
 *
 * `PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT=1` returns `{ enabled: false }`. We
 * set this in `docker-compose.e2e.yml` so Playwright form-login flows
 * don't lock themselves out after a few `loginViaUI` calls. Production
 * deployments never set this env var, and
 * `auth-config-consistency.test.ts` blocks anyone from accidentally
 * adding it to `docker-compose.yml`.
 *
 * Evaluated once at module load (when `auth` is constructed). Changing
 * the env var at runtime has no effect on the live `auth` instance —
 * the container restarts whenever the value changes, which is fine
 * because Docker injects env at process start.
 *
 * Storage is in-memory (Better Auth default). Resets on container restart;
 * acceptable for single-replica self-hosted deployments. If/when we run
 * multiple replicas, switch `storage` to `secondary-storage` (Redis).
 */
type AuthRateLimitRule = { window: number; max: number };
type AuthRateLimitConfig = {
  enabled?: boolean;
  window?: number;
  max?: number;
  customRules?: Record<string, AuthRateLimitRule>;
};

export function getAuthRateLimitConfig(): AuthRateLimitConfig {
  if (process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT === "1") {
    return { enabled: false };
  }
  return {
    // Global fallback for non-auth Better Auth endpoints. 100 req / 10s
    // matches Better Auth's own default global so we don't accidentally
    // throttle benign session checks.
    window: 10,
    max: 100,
    // Per-path hardening for credential-handling endpoints. All windows
    // chosen so a single legitimate user (slow typing, retries) won't
    // hit them but a brute-force / credential-stuffing attacker will.
    customRules: {
      // Pre-auth — brute-force / credential-stuffing protection
      "/sign-in/email": { window: 60, max: 5 }, // was 3/10s = 18/min
      "/sign-up/email": { window: 300, max: 3 },
      // Reset flow — also a spam-DOS vector against user inboxes
      "/forget-password": { window: 600, max: 3 },
      "/forget-password/*": { window: 600, max: 3 },
      "/reset-password": { window: 600, max: 5 },
      "/reset-password/*": { window: 600, max: 5 },
      "/request-password-reset": { window: 600, max: 3 },
      "/send-verification-email": { window: 600, max: 3 },
      // Post-auth — account takeover risk if a session is stolen
      "/change-password": { window: 600, max: 5 },
      "/change-email": { window: 600, max: 3 },
    },
  };
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
