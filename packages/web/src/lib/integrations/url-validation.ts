/**
 * SSRF protection: validates that user-supplied URLs don't target
 * private/internal networks (AWS metadata, localhost, RFC-1918, etc.).
 */

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.", "ip6-localhost", "ip6-loopback"]);

/**
 * Returns true if the hostname is an IPv4 address in a private/reserved range.
 */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;

  // 0.0.0.0/8 — current network
  if (a === 0) return true;
  // 10.0.0.0/8 — class A private
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (AWS metadata lives here)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — class B private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — class C private
  if (a === 192 && b === 168) return true;

  return false;
}

/**
 * Returns true if the hostname is an IPv6 address in a private/reserved range.
 * Handles bracket-stripped addresses (e.g. "::1", "fd12:3456:789a::1").
 */
function isPrivateIPv6(hostname: string): boolean {
  // Strip brackets if present
  const addr = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // ::1 — loopback
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  // :: — unspecified
  if (addr === "::" || addr === "0:0:0:0:0:0:0:0") return true;
  // fc00::/7 — unique local addresses (fc00:: and fd00::)
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
  // fe80::/10 — link-local
  if (addr.startsWith("fe80")) return true;

  return false;
}

/**
 * Returns true if the given URL string targets a private/internal address.
 */
export function isPrivateUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false; // Can't determine — let validateExternalUrl handle parse errors
  }

  const hostname = url.hostname;

  // Check well-known private hostnames
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) return true;

  // Check IPv4 private ranges
  if (isPrivateIPv4(hostname)) return true;

  // Check IPv6 private ranges (URL class strips brackets from hostname)
  if (isPrivateIPv6(hostname)) return true;

  return false;
}

type ValidationResult = { valid: true; url: string } | { valid: false; error: string };

/**
 * Validates a user-supplied URL for server-side requests.
 * Returns the normalized origin or an error message.
 *
 * Set env var ALLOW_PRIVATE_URLS=1 to bypass private IP checks
 * (useful for Docker dev environments with internal service hostnames).
 */
export function validateExternalUrl(urlString: string): ValidationResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL" };
  }

  // Only allow HTTP and HTTPS
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      valid: false,
      error: "Only HTTP and HTTPS URLs are allowed",
    };
  }

  // Check for private/internal addresses (unless bypassed)
  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === "1";
  if (!allowPrivate && isPrivateUrl(urlString)) {
    return {
      valid: false,
      error: "URLs targeting private or internal networks are not allowed",
    };
  }

  // Return normalized origin (scheme + host + port, no path/query)
  return { valid: true, url: url.origin };
}
