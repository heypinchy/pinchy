import { describe, it, expect } from "vitest";
import {
  DOCKER_HOST_ALIASES,
  isOpenClawLocalBaseUrl,
  isOpenClawCompatibleOllamaUrl,
} from "@/lib/openclaw-local-url";

/**
 * Tests for the local-Ollama URL handling. `isOpenClawLocalBaseUrl` is a
 * deliberate STABLE SUBSET of OpenClaw's `isLocalBaseUrl` (only loopback,
 * `.local`, and RFC1918 private IPv4 — conventions OpenClaw won't drop), so it
 * can only ever be a SAFE subset: it never accepts a host OpenClaw would
 * reject. Container-host aliases are handled separately by `DOCKER_HOST_ALIASES`
 * (Pinchy-owned), which `build.ts#rewriteOllamaHostForOpenClaw` normalizes to
 * `ollama.local` — passing OpenClaw via the rock-stable `.local` rule and
 * decoupling us from its host-alias allowlist churn. So this set does NOT need
 * re-verifying against OpenClaw on every bump; it only grows when we choose to
 * support a new container runtime's host alias.
 */
describe("openclaw-local-url", () => {
  describe("DOCKER_HOST_ALIASES", () => {
    it("contains the Docker + OrbStack host aliases that get rewritten to ollama.local in build.ts", () => {
      // Source of truth lives in @/lib/openclaw-local-url; mirrored by
      // build.ts#rewriteOllamaHostForOpenClaw. If a new alias is added,
      // both the rewrite map AND this drift guard must be updated.
      expect([...DOCKER_HOST_ALIASES].sort()).toEqual(
        [
          "docker.for.mac.host.internal",
          "docker.for.win.host.internal",
          "docker.orb.internal",
          "gateway.docker.internal",
          "host.docker.internal",
          "host.orb.internal",
        ].sort()
      );
    });

    it("accepts the OrbStack host aliases (normalized to ollama.local at emit)", () => {
      // OrbStack's host aliases are NOT in OpenClaw's allowlist directly, but
      // the rewrite normalizes them to ollama.local, so they must validate at
      // save time rather than being falsely rejected.
      expect(isOpenClawCompatibleOllamaUrl("http://docker.orb.internal:11434")).toBe(true);
      expect(isOpenClawCompatibleOllamaUrl("http://host.orb.internal:11434")).toBe(true);
      // …while a bare service name that ISN'T a known alias stays rejected.
      expect(isOpenClawCompatibleOllamaUrl("http://ollama:11434")).toBe(false);
    });

    it("is immutable in practice (ReadonlySet contract)", () => {
      // The type contract is ReadonlySet, but JS doesn't enforce it at runtime.
      // Document the assumption — callers must never .add() to this set.
      expect(DOCKER_HOST_ALIASES instanceof Set).toBe(true);
    });
  });

  describe("isOpenClawLocalBaseUrl", () => {
    it("accepts canonical loopback hostnames", () => {
      expect(isOpenClawLocalBaseUrl("http://localhost:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://127.0.0.1:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://0.0.0.0:11434")).toBe(true);
    });

    it("accepts IPv6 loopback literals", () => {
      // Node's URL parser strips brackets from `hostname`, but the upstream
      // predicate keeps a defensive bracket-stripping branch — both bracketed
      // and bare forms must work.
      expect(isOpenClawLocalBaseUrl("http://[::1]:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://[::ffff:7f00:1]:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://[::ffff:127.0.0.1]:11434")).toBe(true);
    });

    it("accepts any *.local hostname", () => {
      expect(isOpenClawLocalBaseUrl("http://foo.local:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://ollama.docker.local:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://my-laptop.local")).toBe(true);
    });

    it("is case-insensitive on the hostname", () => {
      expect(isOpenClawLocalBaseUrl("http://LOCALHOST:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://Foo.Local:11434")).toBe(true);
    });

    it("accepts private IPv4 ranges (10/8, 172.16–172.31/12, 192.168/16)", () => {
      expect(isOpenClawLocalBaseUrl("http://10.0.0.1:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://10.255.255.255:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://172.16.0.1:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://172.31.255.255:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://192.168.0.1:11434")).toBe(true);
      expect(isOpenClawLocalBaseUrl("http://192.168.255.255:11434")).toBe(true);
    });

    it("rejects the 172.x boundaries just outside RFC1918 (172.15 and 172.32)", () => {
      // These are the easiest places to break: a < / > vs <= / >= swap.
      expect(isOpenClawLocalBaseUrl("http://172.15.0.1:11434")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://172.32.0.1:11434")).toBe(false);
    });

    it("rejects non-RFC1918 IPv4 that share a leading octet with private ranges", () => {
      expect(isOpenClawLocalBaseUrl("http://11.0.0.1:11434")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://192.167.0.1:11434")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://192.169.0.1:11434")).toBe(false);
    });

    it("rejects public IPv4 addresses", () => {
      expect(isOpenClawLocalBaseUrl("http://8.8.8.8")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://1.1.1.1")).toBe(false);
    });

    it("rejects out-of-range octets that look IPv4-shaped", () => {
      // The mirror uses Number.parseInt on each octet and bounds 0..255.
      expect(isOpenClawLocalBaseUrl("http://10.0.0.300:11434")).toBe(false);
    });

    it("rejects bare hostnames without a TLD (e.g. Docker service names)", () => {
      // The whole point of #296: `ollama` resolves inside Docker but won't
      // pass the allowlist, so it must be rejected at save time.
      expect(isOpenClawLocalBaseUrl("http://ollama:11434")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://redis:6379")).toBe(false);
    });

    it("rejects public-internet hostnames", () => {
      expect(isOpenClawLocalBaseUrl("https://api.openai.com")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://example.com:11434")).toBe(false);
    });

    it("rejects Docker host aliases — they're only accepted by isOpenClawCompatibleOllamaUrl (via the rewrite map)", () => {
      // Crucial: `isOpenClawLocalBaseUrl` is the 1:1 port of upstream OpenClaw.
      // Upstream does NOT include the Docker aliases — we layer that on in
      // `isOpenClawCompatibleOllamaUrl` because we rewrite them to
      // `ollama.local` at config-emit time. Mixing these up would either
      // (a) silently let real Docker aliases reach OpenClaw unrewritten, or
      // (b) silently break the rewrite path. Keep these two predicates
      // strictly separated.
      expect(isOpenClawLocalBaseUrl("http://host.docker.internal:11434")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://gateway.docker.internal:11434")).toBe(false);
    });

    it("returns false (not throws) on malformed URLs", () => {
      expect(isOpenClawLocalBaseUrl("not-a-url")).toBe(false);
      expect(isOpenClawLocalBaseUrl("")).toBe(false);
      expect(isOpenClawLocalBaseUrl("http://")).toBe(false);
    });
  });

  describe("isOpenClawCompatibleOllamaUrl", () => {
    it("accepts every Docker host alias in DOCKER_HOST_ALIASES", () => {
      // Build the assertion from the set so adding/removing an alias updates
      // both producers and tests in lockstep.
      for (const alias of DOCKER_HOST_ALIASES) {
        expect(isOpenClawCompatibleOllamaUrl(`http://${alias}:11434`)).toBe(true);
      }
    });

    it("accepts everything isOpenClawLocalBaseUrl accepts", () => {
      // Sample a representative subset — `isOpenClawLocalBaseUrl`'s own tests
      // cover the full matrix. We just verify the compatible-Ollama wrapper
      // doesn't accidentally tighten the allowlist.
      expect(isOpenClawCompatibleOllamaUrl("http://localhost:11434")).toBe(true);
      expect(isOpenClawCompatibleOllamaUrl("http://127.0.0.1:11434")).toBe(true);
      expect(isOpenClawCompatibleOllamaUrl("http://ollama.docker.local:11434")).toBe(true);
      expect(isOpenClawCompatibleOllamaUrl("http://192.168.1.50:11434")).toBe(true);
    });

    it("rejects bare Docker service names like http://ollama:11434 (#296 — the bug we're guarding against)", () => {
      expect(isOpenClawCompatibleOllamaUrl("http://ollama:11434")).toBe(false);
    });

    it("rejects public hostnames", () => {
      expect(isOpenClawCompatibleOllamaUrl("https://example.com:11434")).toBe(false);
      expect(isOpenClawCompatibleOllamaUrl("https://ollama.example.com")).toBe(false);
    });

    it("rejects malformed URLs (returns false, does not throw)", () => {
      expect(isOpenClawCompatibleOllamaUrl("not-a-url")).toBe(false);
      expect(isOpenClawCompatibleOllamaUrl("")).toBe(false);
    });

    it("is case-insensitive on Docker host aliases", () => {
      // We lowercase before lookup. A user pasting `HOST.DOCKER.INTERNAL` in
      // the URL field should still pass.
      expect(isOpenClawCompatibleOllamaUrl("http://HOST.DOCKER.INTERNAL:11434")).toBe(true);
    });
  });
});
