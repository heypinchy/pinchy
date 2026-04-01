import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { verifyPassword as verifyScrypt } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";

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
        });
      } catch {
        // Don't break auth if audit logging fails
      }
    }
  }
});

// Detect if HTTPS is configured (via BETTER_AUTH_URL or reverse proxy headers).
// Without HTTPS, cookies must not have the Secure flag or browsers will reject them.
const isHttps = process.env.BETTER_AUTH_URL?.startsWith("https://") ?? false;

export const auth = betterAuth({
  // Trust the origin from the request. Pinchy is self-hosted — the server
  // itself is the trust boundary, not the origin header. This allows login
  // to work whether accessed via IP, localhost, or custom domain without
  // needing to configure BETTER_AUTH_URL upfront.
  trustedOrigins: (request) => {
    const host = request?.headers?.get("x-forwarded-host") ?? request?.headers?.get("host");
    const proto = request?.headers?.get("x-forwarded-proto") ?? "http";
    return host ? [`${proto}://${host}`] : [];
  },
  advanced: {
    // In production (NODE_ENV=production), Better Auth defaults to Secure cookies.
    // On plain HTTP (no BETTER_AUTH_URL with https://), browsers silently reject
    // Secure cookies — causing login to appear to succeed but sessions to not persist.
    useSecureCookies: isHttps,
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

// Better Auth v1.5.3 doesn't infer admin plugin fields in $Infer.Session.
// Manually extend the session type to include them.
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
