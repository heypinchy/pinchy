# Secret Handling

Read this before handling a credential, an API key or an `openclaw.json` value, or changing how a plugin fetches credentials. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## Secret Handling

Pick the secret-handling pattern based on who consumes the secret at runtime.

### Pattern A: OpenClaw built-in resolves SecretRef

Use `secretRef(pointer)` from `packages/web/src/lib/openclaw-secrets.ts` for paths OpenClaw itself walks at runtime:

- `models.providers.<name>.apiKey`
- `env.<VAR>` templates resolved against process env

Add the value to the `SecretsBundle`, write the reference into `openclaw.json`, and test both halves.

### Pattern B: Pinchy plugins fetch credentials through the API

Preferred for credentials consumed by `packages/plugins/pinchy-*` plugins.

Do not put third-party credentials, or even a SecretRef pointer, into arbitrary plugin config blocks in `openclaw.json`. OpenClaw 2026.4.x does not resolve SecretRefs in arbitrary plugin config trees, so plugins can receive unresolved objects.

Instead:

- `regenerateOpenClawConfig()` writes only `apiBaseUrl`, `gatewayToken`, and an opaque `connectionId` into plugin config.
- The plugin lazily fetches credentials from `GET /api/internal/integrations/:connectionId/credentials?agentId=<id>` using the gateway token as Bearer auth. **The `agentId` is required**: the gateway token is one shared secret inlined into every plugin's config, so it proves the caller is inside the OpenClaw container and nothing about which connections it may read. Pinchy checks the named agent's grant (`agent_connection_permissions`, or the tool grant for the instance-wide web-search connection) before decrypting, and a refusal writes an `integration.credentials_denied` audit row (#987). A new plugin that fetches credentials must pass its `ctx.agentId` through — omitting it is a `400`, deliberately, because a lenient fallback would be a one-parameter route back to token-only authorization.
- Cache credentials in the plugin, usually with a 5-minute TTL, and invalidate on 401 for rotation.
- Validate credential shapes at the plugin edge with clear type errors.
- Test web config emission, plugin cache/refetch behavior, plugin integration against mocks, and manual staging behavior when relevant.

Every Pinchy plugin manifest must declare every config field emitted by `regenerateOpenClawConfig()` and use `additionalProperties: false`. Keep these in sync when adding or changing a plugin:

- `KNOWN_PINCHY_PLUGINS` in `packages/web/src/lib/openclaw-config/plugin-manifest-loader.ts`
- The plugin's `openclaw.plugin.json#configSchema`
- The plugin's `config-schema.test.ts`

### Pattern C: Bootstrap credentials

`gateway.auth.token` and `plugins.entries.pinchy-*.config.gatewayToken` are plaintext bootstrap credentials in `openclaw.json`. They are the trust root for the OpenClaw container and cannot be fetched through Pinchy's API. Pinchy keeps the token in its database (`openclaw_gateway_token`) and writes the same value on every config regeneration, so regenerating does not rotate it; there is no rotation control today. While a config apply briefly leaves `openclaw.json` unreadable, `readGatewayToken()` serves the last good token for at most 60 s, and the audit hook and the credentials fetch retry a 401 from Pinchy for about 3.75 s; other plugins do not retry.

Defense in depth:

- `packages/web/src/lib/openclaw-plaintext-scanner.ts` checks generated `openclaw.json` for known provider key prefixes. Add patterns when onboarding providers with recognizable secret prefixes.
- `packages/web/src/lib/openclaw-config/validate-built-config.ts` validates emitted plugin entries against manifests before writing config.

### Three Digits Are Not A Status

Every Pattern-B plugin needs the same four things: fetch the credentials, cache them, decide whether an error means "these are stale", and retry once. `pinchy-odoo`, `pinchy-email` and `pinchy-web` each grew their own, and by 2026-08 all three had drifted (#1077) — three cache-key conventions, three auth matchers, and in every one of them a test for the bare substring `401`:

```
odoo   'access denied' | 'invalid api key' | '401' | 'authenticat'
email  '401' | 'invalid credentials' | 'invalid_grant' | 'token has been expired' | 'unauthorized'
web    '401' | 'unauthor' | 'invalid api'
```

Odoo's `MissingError` names the record (`Records: sale.order(401,)`). An unbalanced-entry error names the amount. Graph echoes the recipient, and a mail about a 401(k) plan carries those digits into the error body — as does the GUID request-id Microsoft stamps on every error, in roughly one failure in seventy. The cost is not a wasted retry: the second failure POSTs `report-auth-failure`, which flips the connection to `auth_failed`, shows admins a "reconnect" banner in Settings → Integrations, and writes an `integration.auth_failed` audit row for an auth failure that never happened.

So: **a number classifies only as a structured status; prose classifies only on words.** `isAuthError` in `credential-client.ts` reads `status`/`statusCode`/`response.status`/numeric `code` first and falls back to word patterns — never to digits. That narrowing has a price, and paying it is part of the change: `BraveSearchError` and `GraphRequestError` now carry `status`, because Brave's real 401 body (`{"code":"SUBSCRIPTION_TOKEN_INVALID"}`) contains no auth word at all and would otherwise stop triggering a refresh. A new provider client that throws on a non-ok response must carry its status the same way.

Three more rules fall out of the same incident:

- **The module is duplicated, byte-for-byte, and that is forced rather than sloppy.** Each plugin directory is mounted into the OpenClaw container standalone (`./packages/plugins/<name>:/root/.openclaw/extensions/<name>`), so an import escaping the plugin directory resolves to a path that is not there at runtime — the same bundle-isolation shape as `normalizeTableHtml`, with the same answer. `plugin-credential-client-drift.test.ts` compares the copies byte-for-byte and also fails on a plugin that grows a _second_ classifier in its own `index.ts`, which the byte comparison cannot see. Edit the `pinchy-odoo` copy, then copy it over the other two. The module's unit tests live once (`pinchy-odoo/__tests__/credential-client.test.ts`) and count for all three copies only for as long as that guard passes.
- **A cache key names every input the cached value was built from.** `credentialCacheKey(agentId, connectionId)` — odoo keyed on the agent alone, so a client built from one connection's credentials could outlive a connection swap by a full TTL. Reachability today depends on OpenClaw re-running `register()` on a config change (which rebuilds the cache anyway); the key is still wrong, and "the other input happens to be constant right now" is a property of today's config, not of the cache.
- **The retry may repeat the closure only while nothing has been written.** `trackMutations` wraps the client and marks a mutation when a mutating method **resolves** — not when it is called. That distinction is the whole point: a rejected write changed nothing (an Odoo RPC is transactional, a rejected send did not send), so re-running it under a fresh token is exactly what the retry exists for; marking on entry would disable the transparent refresh for every write tool. No closure in the tree performs a step after its mutating call today, so this is a **tripwire**, not a live fix — it fires the moment someone adds one, instead of that edit silently duplicating a record or an email. Wrapping centrally rather than annotating ~30 call sites is what makes it unforgettable. That same fact is why the gate cannot be proved by running it, and deleting `if (mutated) throw err` from `pinchy-odoo/index.ts` leaves all 493 of that plugin's tests green — so the drift guard checks textually instead: a plugin that wraps a client in `trackMutations` must also read the flag. Derived from the source rather than from a list, so a write tool landing in `pinchy-web` is covered the day it arrives.
