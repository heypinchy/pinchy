/**
 * Mirror of OpenClaw's `isLocalBaseUrl` predicate
 * (model-auth-CsyLGY9m.js:111-118 + isPrivateIpv4Host:120-126). OpenClaw
 * does not export the function through any of its public subpath exports,
 * so we re-implement it here as a 1:1 port and use it both at save time
 * (providers.ts → reject unsupported hosts before they hit the DB) and as
 * a drift guard in openclaw-config.test.ts.
 *
 * If upstream changes the allowlist, this mirror won't auto-detect it —
 * anyone bumping the `openclaw` version pin should grep for
 * `OPENCLAW_ISLOCAL_PIN` and re-verify the predicate, then update the
 * docs in ollama-setup.mdx if the allowlist semantics changed.
 *
 * OPENCLAW_ISLOCAL_PIN: 2026.4.27 (re-verify on bump; see PR #279)
 */

/**
 * Docker host aliases that all resolve to "the host machine running
 * Docker". None of them pass OpenClaw's `isLocalBaseUrl` allowlist
 * directly, but `build.ts#rewriteOllamaHostForOpenClaw` rewrites every
 * one of them to `ollama.local` before the URL ever lands in the
 * emitted `openclaw.json`. The save-time validator accepts these as
 * "would pass after rewrite" so users can paste the placeholder URL
 * (`host.docker.internal:11434`) without seeing a spurious rejection.
 *
 * Kept in sync with `DOCKER_HOST_ALIASES` in openclaw-config/build.ts.
 */
export const DOCKER_HOST_ALIASES: ReadonlySet<string> = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "docker.for.mac.host.internal",
  "docker.for.win.host.internal",
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
