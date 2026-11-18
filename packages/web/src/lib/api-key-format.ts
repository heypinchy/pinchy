/**
 * The shape of a Pinchy API key, in one place.
 *
 * This module exists so the prefix is a single constant rather than two
 * strings that happen to agree: `auth.ts` hands it to the plugin as
 * `defaultPrefix` (which is what actually mints keys), and `withApiKey` uses
 * it to reject a candidate before paying for verification. Were those to
 * drift, the filter would start rejecting valid keys — an outage across the
 * whole API, caused by a check that was meant to be free.
 */

/**
 * Every key Pinchy issues is `pinchy_<random>`.
 *
 * Guaranteed rather than conventional: `/api/settings/api-keys` is the only
 * path that mints a key (the plugin's own `/api-key/*` endpoints are answered
 * 404 for client requests, see the `hooks.before` guard in auth.ts), and it
 * passes no `prefix`, so every key falls through to `defaultPrefix`.
 *
 * It is also a documented promise — the Agent Provisioning API reference says
 * keys are always prefixed this way so they're recognizable in logs, shell
 * history and secret scanners. Changing it invalidates every key in every
 * deployment at once.
 */
export const API_KEY_PREFIX = "pinchy_";

/**
 * Whether `candidate` could be a Pinchy key at all.
 *
 * Deliberately a shape check and nothing more — it says a string is not one of
 * ours, never that it is. Verification stays with `auth.api.verifyApiKey`.
 *
 * The point is what it saves: verification hashes the candidate and does a
 * database lookup, and `/api/v1/*` is reachable by anyone. This turns the
 * traffic that pays for none of that — scanners spraying other products'
 * token formats — into a string comparison.
 *
 * It is a complement to `tryAcquireInvalidApiKeyIpSlot`
 * (lib/api-key-rate-limiter.ts), not a substitute, and the division of labour
 * is worth stating: that limiter bounds how many invalid attempts an address
 * gets an ANSWER for, but it is consulted after `verifyApiKey` has already
 * run, so it never bounded the work. This bounds the work and bounds nothing
 * else — a caller who knows the prefix still reaches the lookup, and the
 * per-IP limiter is what covers them.
 *
 * Leaks nothing: the prefix is published in the docs, so a timing difference
 * between "wrong shape" and "wrong key" tells an attacker what they read.
 */
export function looksLikeApiKey(candidate: string): boolean {
  return candidate.length > API_KEY_PREFIX.length && candidate.startsWith(API_KEY_PREFIX);
}
