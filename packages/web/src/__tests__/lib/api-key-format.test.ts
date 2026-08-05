/**
 * The cheap shape check that runs before `verifyApiKey` (#1086).
 *
 * `withApiKey` reaches key verification through `auth.api.*`, which hashes the
 * candidate and does a database lookup. Anyone on the internet can trigger
 * that with a made-up string, so the one filter that costs nothing is worth
 * having: a key that cannot possibly be one of ours is rejected before the
 * round trip.
 *
 * The load-bearing property is that `API_KEY_PREFIX` is the SAME constant
 * `auth.ts` hands the plugin as `defaultPrefix`. If those two ever became two
 * strings that merely agreed, this filter would start rejecting valid keys the
 * day one of them changed — a self-inflicted outage on the whole API.
 */
import { describe, it, expect } from "vitest";

import { API_KEY_PREFIX, looksLikeApiKey } from "@/lib/api-key-format";

describe("looksLikeApiKey", () => {
  it("accepts a key carrying the prefix Pinchy issues", () => {
    expect(looksLikeApiKey(`${API_KEY_PREFIX}abcdef0123456789`)).toBe(true);
  });

  it("rejects a string without the prefix, so a sprayed bearer token costs no lookup", () => {
    // What a credential scanner actually sends: someone else's token format.
    expect(looksLikeApiKey("sk-live-4eC39HqLyjWDarjtT1zdp7dc")).toBe(false);
    expect(looksLikeApiKey("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });

  it("is case-sensitive — the prefix is a literal, not a scheme name", () => {
    // Unlike the `Bearer` scheme (RFC 7235 makes that case-insensitive), the
    // prefix is part of the secret's bytes: better-auth hashes the whole
    // string, so `PINCHY_x` would never verify anyway. Accepting it here would
    // only buy the attacker back the database lookup.
    expect(looksLikeApiKey("PINCHY_abcdef0123456789")).toBe(false);
  });

  it("rejects a prefix that merely appears somewhere in the string", () => {
    expect(looksLikeApiKey(`junk${API_KEY_PREFIX}abcdef`)).toBe(false);
  });

  it("does not accept the bare prefix with nothing after it", () => {
    expect(looksLikeApiKey(API_KEY_PREFIX)).toBe(false);
  });

  it("keeps the prefix Pinchy has always issued", () => {
    // Not decoration: every key ever minted carries this, and the reference
    // documents it as a promise ("Keys are always prefixed `pinchy_`"). A
    // change here invalidates every key in every deployment at once.
    expect(API_KEY_PREFIX).toBe("pinchy_");
  });
});
