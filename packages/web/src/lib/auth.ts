import { betterAuth, type BetterAuthRateLimitOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { verifyPassword as verifyScrypt } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { SIGN_IN_RATE_LIMIT_WINDOW_SECONDS } from "@/lib/auth-rate-limit";
import { getCachedDomain } from "@/lib/domain";
import { shouldUseSecureCookies } from "@/lib/secure-cookies";
import { PASSWORD_MIN_LENGTH } from "@/lib/validate-password";

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
          // GDPR Art. 17: never log plaintext email — the audit row is
          // HMAC-signed and cannot be redacted later. redactEmail()
          // gives us a keyed hash + masked preview instead.
          detail: redactEmail(email),
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
          detail: { ...redactEmail(email), reason: "invalid_credentials" },
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
export function getAuthRateLimitConfig(): BetterAuthRateLimitOptions {
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
    //
    // Better Auth's customRules resolver iterates Object.keys() in insertion
    // order, so exact paths are listed BEFORE their corresponding wildcard
    // entries — `/sign-in/email` matches first; the `/sign-in/*` fallback
    // covers any future sub-path (OAuth, magic-link, passkey) we add.
    customRules: {
      // Pre-auth — brute-force / credential-stuffing protection
      // The window is shared with the login page, which tells the user how long
      // to wait — see @/lib/auth-rate-limit.
      "/sign-in/email": { window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS, max: 5 }, // was 3/10s = 18/min
      "/sign-in/*": { window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS, max: 5 },
      "/sign-up/email": { window: 300, max: 3 },
      "/sign-up/*": { window: 300, max: 3 },
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
    // Secure cookies (and Better Auth's `__Secure-` cookie-NAME prefix) when a
    // domain is locked = HTTPS/secure mode. Read from a synchronous persistent
    // flag, NOT the async in-memory domain cache: the cache is cold at this
    // import, so its value flipped between container generations, the cookie
    // name changed, and every update logged users out. See @/lib/secure-cookies.
    // (Without HTTPS the Secure flag/`__Secure-` prefix must be off or browsers
    // reject the cookie — the flag defaults to insecure when absent.)
    useSecureCookies: shouldUseSecureCookies(),
    // Explicit rather than relying on Better Auth's/the browser's implicit
    // default. The WS upgrade path (server.ts) has no CORS-equivalent
    // defense of its own — WebSocket handshakes aren't subject to CORS/SOP —
    // so the session cookie's SameSite attribute is part of the actual
    // defense-in-depth against cross-site WebSocket hijacking. "lax" (not
    // "strict") preserves today's behavior: "strict" would drop the cookie on
    // legitimate top-level-navigation flows, e.g. an email-verification link
    // landing the user on an authenticated page.
    defaultCookieAttributes: {
      sameSite: "lax",
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      apikey: schema.apiKeys,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Mirror Pinchy's policy (see lib/validate-password.ts) so Better Auth's
    // own /sign-up and /change-password paths cannot accept passwords below
    // our length floor. Pinchy's route validators run validatePassword first
    // and enforce the full policy (length + letter+digit + breach-list);
    // this is defense in depth.
    minPasswordLength: PASSWORD_MIN_LENGTH,
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
    // Agent Provisioning API (#572): programmatic clients authenticate with
    // `pinchy_`-prefixed API keys instead of session cookies.
    apiKey({
      // D1 security: an API key must NEVER resolve to a full user session —
      // keys are scoped machine credentials, not login tokens. Defaults false;
      // set explicitly as belt-and-suspenders against a future default flip.
      //
      // ⚠️ Also load-bearing for key OWNERSHIP (lib/api-key-identity.ts):
      // keys are issued against a constant service-account `referenceId`, not
      // a user id. The plugin's session-from-key hook is the one place that
      // resolves that column (`findUserById`, rejecting a miss with
      // UNAUTHORIZED), and this flag is what stops that hook from ever being
      // registered — the plugin gates its own matcher on it. Turning this on
      // would therefore break every key at once: fail-closed, but baffling
      // unless you've read this. D1 and the service-account id are one
      // decision, not two.
      enableSessionForAPIKeys: false,
      // One-time key format: `pinchy_<random>`.
      defaultPrefix: "pinchy_",
      // MUST stay longer than `defaultPrefix`. The plugin stores
      // `start = key.substring(0, charactersLength)` as the masked identifier,
      // and its default is 6 — one character SHORTER than `pinchy_`. Left
      // alone, every key's `start` is the constant "pinchy": the Settings →
      // API Keys column that exists to tell keys apart would show `pinchy…` on
      // every row. That column is the only handle an admin has, because the
      // plaintext is shown once and never stored — so 7 for the prefix + 6 real
      // characters, matching the plugin's own intent for the field.
      // Locked in by auth-apikey.integration.test.ts, against a real key.
      startingCharactersConfig: { charactersLength: "pinchy_".length + 6 },
      // Defaults to false. Pinchy stores exactly one thing here: the
      // `createdBy` provenance snapshot behind "whose key is this, and do we
      // rotate it now that they've left?" (lib/api-key-identity.ts). Never
      // secrets — the column is plain text to anything holding a DB
      // connection, and GET /api/settings/api-keys masks it down to
      // `createdBy` on the way out.
      enableMetadata: true,
      // The plugin's built-in per-key limiter defaults to 10 requests / 24h,
      // which would throttle a legitimately busy API client, so it's off.
      // NOTE: there is no Pinchy-side replacement — an authenticated key is
      // currently unthrottled on /api/v1/*. Fine for the trusted-automation
      // threat model these keys are for (an admin issued it deliberately),
      // but it is a gap, not a delegation.
      rateLimit: { enabled: false },
    }),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // C1 (#572 whole-branch review, CRITICAL): registering the apiKey()
      // plugin above mounts FIVE endpoints as ordinary Better Auth routes —
      // /api-key/create|update|delete|get|list. Those are exactly the
      // plugin's path-carrying endpoints; the two it declares via
      // `createAuthEndpoint.serverOnly` (verifyApiKey and
      // deleteAllExpiredApiKeys) carry no path, so they were never HTTP
      // surface to begin with — see the ctx.path note below.
      //
      // Since app/api/auth/[...all]/route.ts mounts the whole auth handler,
      // those five are live at /api/auth/api-key/* for ANY authenticated
      // session, not just admins — bypassing our audited, admin-gated
      // /api/settings/api-keys route entirely (no admin check, no
      // api_key.created/deleted audit row).
      //
      // Pinchy issues/revokes keys ONLY via /api/settings/api-keys (withAdmin
      // + audited). Block every CLIENT request to /api-key/* here — a 404,
      // not a 403/401, so the mounted-but-forbidden sub-path stays invisible
      // rather than confirming a governed route exists.
      //
      // `ctx.request || ctx.headers` is the SAME discriminator the plugin's
      // own create/update handlers use internally (see
      // @better-auth/api-key/dist/index.mjs: `isClientRequest = ctx.request
      // || ctx.headers`) to tell a browser/HTTP client request apart from a
      // trusted server-side call. Our own server-side call —
      // `auth.api.createApiKey({ body })` in
      // app/api/settings/api-keys/route.ts — passes neither `request` nor
      // `headers`, so it is unaffected by this guard. `ctx.path` for that
      // call is `"/api-key/create"`; for the server-only `verifyApiKey` call
      // (used by every /api/v1 request via withApiKey) `ctx.path` is `"/"` —
      // server-only endpoints take no path, which is also why they are not
      // part of the HTTP surface above — so it never matches this prefix
      // check either. Verified empirically against the real Better Auth
      // dispatch pipeline, not just read from source.
      if (ctx.path.startsWith("/api-key/") && (ctx.request || ctx.headers)) {
        throw new APIError("NOT_FOUND", { message: "Not found" });
      }
    }),
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
