/**
 * A deliberately CONSERVATIVE subset of OpenClaw's `isLocalBaseUrl` predicate,
 * used at save time (providers.ts → reject unsupported hosts before they hit
 * the DB). OpenClaw doesn't export the function, so we re-implement only the
 * parts that are CONVENTIONS — loopback, `.local` (mDNS / RFC 6762), and
 * RFC1918 private IPv4. Those have been in every OpenClaw version and won't
 * drop, so this subset can only ever be a SAFE predictor: anything it accepts,
 * OpenClaw accepts too (no false acceptance → no surprise runtime "No API key"
 * failure).
 *
 * It intentionally does NOT mirror OpenClaw's volatile container-host aliases
 * (`host.docker.internal`, `*.orb.internal`, …). Those are handled by
 * `DOCKER_HOST_ALIASES` + the `ollama.local` rewrite (see below), which
 * decouples us from OpenClaw's allowlist churn. So — unlike a 1:1 port — this
 * does NOT need re-verifying against OpenClaw on every version bump; the worst
 * case is a soft, correctable false REJECTION of an alias we haven't listed,
 * never a hard false acceptance.
 *
 * Verified safe-subset-of against OpenClaw 2026.6.8 (`src/agents/model-auth.ts`
 * `isLocalBaseUrl`). See PR #279 for the original derivation.
 */

/**
 * Container-host aliases that all resolve to "the host machine running the
 * container runtime" (Docker Desktop, plain Docker on Linux, OrbStack).
 * `build.ts#rewriteOllamaHostForOpenClaw` rewrites every one of them to
 * `ollama.local` before the URL lands in the emitted `openclaw.json`, and the
 * save-time validator accepts them as "would pass after rewrite" so users can
 * paste the placeholder (`host.docker.internal:11434`) without a spurious
 * rejection.
 *
 * Why normalize them all to `ollama.local` instead of passing the alias
 * through? Because `ollama.local` clears OpenClaw's `isLocalBaseUrl` via the
 * `.local` (mDNS / RFC 6762) rule — the single most stable entry in that
 * allowlist — which **decouples Pinchy from OpenClaw's host-alias allowlist
 * churn**. OpenClaw has changed which Docker aliases it accepts more than once
 * (2026.4.27 had none of these; 2026.6.x added `host.docker.internal` +
 * `*.orb.internal`). Relying on a specific alias being in that allowlist would
 * make a routine OpenClaw bump able to break local Ollama for every self-hoster
 * with a "No API key" error. So this rewrite is a deliberate, load-bearing
 * decoupling — NOT a version-specific workaround to be "cleaned up" later.
 *
 * This list is Pinchy-owned (it grows only when we choose to support a new
 * runtime's alias) and is kept in sync with the rewrite in
 * openclaw-config/build.ts.
 */
export const DOCKER_HOST_ALIASES: ReadonlySet<string> = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "docker.for.mac.host.internal",
  "docker.for.win.host.internal",
  // OrbStack's native host aliases (Docker Desktop alternative).
  "docker.orb.internal",
  "host.orb.internal",
]);

function isPrivateIpv4Host(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const octets = host.split(".").map((o) => Number.parseInt(o, 10));
  if (octets.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 1:1 port of OpenClaw's `isLocalBaseUrl` predicate. Returns true iff
 * the URL's hostname is on OpenClaw's local-provider allowlist.
 */
export function isOpenClawLocalBaseUrl(baseUrl: string): boolean {
  try {
    let host = new URL(baseUrl).hostname.toLowerCase();
    // Defensive parity with upstream — on Node/V8 `URL.hostname` already
    // returns IPv6 literals without brackets, so this branch is currently
    // dead. Keep it so the mirror stays a 1:1 port of the upstream source
    // and a future Node engine change can't silently diverge us.
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "::ffff:7f00:1" ||
      host === "::ffff:127.0.0.1" ||
      host.endsWith(".local") ||
      isPrivateIpv4Host(host)
    );
  } catch {
    return false;
  }
}

/**
 * Returns true if the user-supplied Ollama URL will pass OpenClaw's
 * `isLocalBaseUrl` allowlist — either directly, or after
 * `build.ts#rewriteOllamaHostForOpenClaw` rewrites a Docker host alias
 * to `ollama.local`.
 *
 * This is what `validateProviderUrl` enforces at save time: if it
 * returns false, the URL would be saved successfully and then fail
 * silently at chat time with "No API key found for provider 'ollama'".
 */
export function isOpenClawCompatibleOllamaUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (DOCKER_HOST_ALIASES.has(host)) return true;
    return isOpenClawLocalBaseUrl(rawUrl);
  } catch {
    return false;
  }
}
