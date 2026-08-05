/**
 * Shared credential/HTTP client for the Pinchy plugins that fetch third-party
 * credentials through Pinchy's internal API (AGENTS.md, Secret Handling
 * Pattern B): pinchy-odoo, pinchy-email, pinchy-web.
 *
 * DUPLICATED ON PURPOSE, byte-for-byte, one copy per plugin. Each plugin
 * directory is mounted into the OpenClaw container standalone —
 * `./packages/plugins/<name>:/root/.openclaw/extensions/<name>` in
 * docker-compose.dev.yml, one `COPY packages/plugins/<name>` per plugin in
 * Dockerfile.openclaw — so an import that escapes the plugin directory
 * resolves to a path that is not there at runtime. A copy per plugin is the
 * only shape that deploys; this is the same bundle-isolation argument
 * `normalizeTableHtml` makes, and it gets the same answer: duplicate the
 * source and let a textual drift guard hold the copies together
 * (`packages/web/src/__tests__/lib/plugin-credential-client-drift.test.ts`).
 *
 * The guard exists because the copies had ALREADY drifted (#1077). Each
 * plugin had grown its own auth-error matcher, and every one of them
 * classified on the bare substring "401":
 *
 *   odoo   'access denied' | 'invalid api key' | '401' | 'authenticat'
 *   email  '401' | 'invalid credentials' | 'invalid_grant' | 'token has been expired' | 'unauthorized'
 *   web    '401' | 'unauthor' | 'invalid api'
 *
 * Three digits are not a status. Odoo's MissingError names the record id
 * ("Records: account.move(401,)"), an unbalanced-entry error names the
 * amount, an email about a 401(k) plan names the plan — and a message that
 * merely contains those digits was read as "the credentials are stale". The
 * consequence is not a wasted retry: after the second failure the plugin
 * POSTs report-auth-failure, which flips the connection to `auth_failed`,
 * shows admins a "reconnect" banner in Settings → Integrations, and writes an
 * `integration.auth_failed` audit row blaming an auth failure that never
 * happened.
 *
 * So the rule here is: a number classifies only when it arrives as a
 * STRUCTURED status; prose classifies only on words.
 */

/**
 * Bounds every call to Pinchy's own internal API against a hung container or a
 * network blackhole with no RST. 10s matches what each plugin used before
 * these two calls moved in here; external calls (Brave, Graph) bound
 * themselves at 30s where they are made. A timeout surfaces as an AbortError,
 * which every caller already treats as an ordinary fetch failure — and which
 * `isAuthError` deliberately does not classify, so a hung endpoint never
 * flags a connection as auth_failed.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Thrown by `requestCredentials` when the credentials API answers non-ok.
 * Carries `status` so callers can discriminate (pinchy-email gates its
 * settings-missing handling strictly on 503) without string-matching a
 * message.
 */
export class CredentialsFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CredentialsFetchError";
    this.status = status;
  }
}

/**
 * Cache key for a per-agent credential/client cache.
 *
 * The connectionId is part of the key, not decoration: pinchy-odoo used to
 * key on the agentId alone, so re-pointing an agent at a different Odoo
 * connection kept serving a client built from the OLD connection's
 * credentials for up to the cache TTL (#1077).
 */
export function credentialCacheKey(agentId: string, connectionId: string): string {
  return `${agentId}:${connectionId}`;
}

/**
 * The HTTP status an error carries, or null when it carries none.
 *
 * Read this BEFORE the message: a status is what the provider said, a message
 * is prose that happens to contain digits. `code` counts only when it is a
 * number — a Node system error puts a string there (`ECONNRESET`), and
 * odoo-node puts the HTTP status there for a transport-level failure.
 */
export function authErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const response = e.response;
  const candidates: unknown[] = [
    e.status,
    e.statusCode,
    e.code,
    response && typeof response === "object"
      ? (response as Record<string, unknown>).status
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return null;
}

/**
 * Message shapes that mean "these credentials are stale". Every entry is a
 * string a provider we actually talk to emits; matched against the
 * lower-cased message.
 *
 * Note what is NOT here: a bare `401`. The canonical reason phrase
 * ("401 Unauthorized") is caught by the `unauthori` pattern, and a 401 that
 * carries no auth word at all — Brave answers
 * `(401): {"code":"SUBSCRIPTION_TOKEN_INVALID"}` — is caught by
 * `authErrorStatus`, which is why the call sites that build those errors were
 * taught to carry the status.
 */
const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  // "401 Unauthorized", "Unauthorised", Graph/Gmail/Brave bodies.
  /\bunauthori[sz]/,
  // Odoo raises AccessDenied when the API key is rotated or revoked.
  /\baccess denied\b/,
  // odoo-node throws this literally; imapflow uses it for a bad login.
  /\bauthentication (failed|error|required|denied)\b/,
  /\bfailed to authenticate\b/,
  // "invalid api key" (Odoo), "Invalid Credentials" (Gmail/IMAP),
  // "invalid_grant" (OAuth refresh). `api (key|token)` and not just
  // `api key`: pinchy-web's matcher tested the bare prefix "invalid api", so
  // dropping "invalid api token" would be a narrowing beyond the one this
  // module set out to make — digits, not words.
  /\binvalid[ _-]?(api[ _-]?(key|token)|credentials?|token|grant|authentication)\b/,
  // Graph: "Access token has expired or is not yet valid."
  /\b(access[ _-]?)?token (has |have )?(been )?expired\b/,
  /\bexpired[ _-](access[ _-]?)?token\b/,
  /\bsession (has )?expired\b/,
];

/**
 * Is this error the provider telling us the credentials are stale?
 *
 * A `true` here is expensive: it invalidates the cache, spends a credentials
 * round trip, re-runs the caller's closure, and on a second failure flags the
 * connection as broken for every admin who looks at it. Default to `false`.
 */
export function isAuthError(err: unknown): boolean {
  if (authErrorStatus(err) === 401) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = message.toLowerCase();
  return AUTH_MESSAGE_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * GET the decrypted credentials for one connection from Pinchy's internal
 * API and return the parsed JSON body. The caller owns the shape assertion —
 * it is different per plugin and it is where the #209 SecretRef check lives.
 *
 * `agentId` is required by the route (#987): the gateway token is shared by
 * every plugin, so it proves the caller is inside the OpenClaw container and
 * nothing about which connections this agent may read.
 *
 * See: packages/web/src/app/api/internal/integrations/[connectionId]/credentials/route.ts
 */
export async function requestCredentials(args: {
  apiBaseUrl: string;
  gatewayToken: string;
  connectionId: string;
  agentId: string;
  label: string;
}): Promise<unknown> {
  const { apiBaseUrl, gatewayToken, connectionId, agentId, label } = args;
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials` +
      `?agentId=${encodeURIComponent(agentId)}`,
    {
      headers: { Authorization: `Bearer ${gatewayToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    // The route puts an actionable message in the JSON body (a 404 "This
    // integration is no longer connected …", a 503 naming the missing OAuth
    // settings) — surface it so the agent reports something a user can act
    // on, not a bare HTTP status. Read the body tolerantly: a non-JSON body,
    // or a response object without a usable `.json` at all (which throws
    // synchronously rather than rejecting, so `.catch()` alone would not
    // save us), must not mask the original status.
    const body = await (async () => {
      try {
        return (await response.json()) as { error?: unknown };
      } catch {
        return null;
      }
    })();
    const detail = body && typeof body.error === "string" ? `: ${body.error}` : "";
    throw new CredentialsFetchError(
      `Failed to fetch ${label} credentials for connection ${connectionId}: ` +
        `HTTP ${response.status} ${response.statusText}${detail}`,
      response.status
    );
  }

  return response.json();
}

/**
 * Best-effort POST to Pinchy's report-auth-failure endpoint after a
 * retry-once cycle failed with a permanent auth error. Lets Pinchy show
 * admins a "reconnect" banner instead of making them trawl agent transcripts.
 *
 * Errors are swallowed: this must never mask the original tool error.
 */
export async function postAuthFailure(args: {
  apiBaseUrl: string;
  connectionId: string;
  gatewayToken: string;
  pluginId: string;
  reason: string;
}): Promise<void> {
  const { apiBaseUrl, connectionId, gatewayToken, pluginId, reason } = args;
  try {
    await fetch(`${apiBaseUrl}/api/internal/integrations/${connectionId}/report-auth-failure`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
        "X-Plugin-Id": pluginId,
      },
      // The route's schema caps `reason` at 500 chars and rejects longer
      // bodies with a 400, which would lose the report entirely.
      body: JSON.stringify({ reason: reason.slice(0, 500) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // best-effort — never mask the original tool error
  }
}

/**
 * Wrap a client so the auth retry can tell whether the closure it is about to
 * re-run has already changed something on the far side.
 *
 * `onMutation` fires when one of `mutatingMethods` RESOLVES — not when it is
 * called. That distinction is the whole point: a mutating call that rejected
 * changed nothing (an Odoo RPC is transactional, a rejected send did not
 * send), so re-running it under a fresh token is exactly what the retry is
 * for. Marking on entry would disable the transparent token refresh for every
 * write tool.
 *
 * Today no closure in any of the three plugins performs a step after its
 * mutating call, so this is a tripwire rather than a live fix — it fires the
 * moment someone adds one, instead of that edit silently making the retry
 * duplicate a write (#1077). Wrapping centrally rather than flagging the ~30
 * call sites is what makes it unforgettable.
 */
export function trackMutations<T extends object>(
  target: T,
  mutatingMethods: readonly string[],
  onMutation: () => void
): T {
  const tracked = new Set(mutatingMethods);
  return new Proxy(target, {
    get(obj, prop) {
      // Read the property off the real target, never through the proxy: the
      // client's own internals (`this.execute(...)`) must not be re-entered
      // through the trap.
      const value = (obj as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== "string" || !tracked.has(prop) || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const out = (value as (...a: unknown[]) => unknown).apply(obj, args);
        if (out instanceof Promise) {
          return out.then((resolved) => {
            onMutation();
            return resolved;
          });
        }
        onMutation();
        return out;
      };
    },
  });
}
