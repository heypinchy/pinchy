import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import dns from "node:dns/promises";

export interface WebFetchConfig {
  allowedDomains?: string[];
  excludedDomains?: string[];
  maxChars?: number;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

export async function webFetch(
  url: string,
  config: WebFetchConfig = {},
): Promise<{ content: string; isError?: boolean }> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { content: `Invalid URL: ${url}`, isError: true };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { content: `Only HTTP/HTTPS URLs are supported.`, isError: true };
  }

  // Domain filtering
  const hostname = parsed.hostname;
  if (config.allowedDomains?.length) {
    const allowed = config.allowedDomains.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (!allowed) {
      return {
        content: `This agent is not allowed to fetch content from ${hostname}. Allowed domains: ${config.allowedDomains.join(", ")}`,
        isError: true,
      };
    }
  }
  if (config.excludedDomains?.length) {
    const excluded = config.excludedDomains.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (excluded) {
      return {
        content: `Domain ${hostname} is blocked for this agent.`,
        isError: true,
      };
    }
  }

  // SSRF guard — resolve hostname and check IPs
  try {
    // Check if hostname is already an IP literal
    if (isPrivateIp(hostname)) {
      return {
        content: `Access to private network addresses is not allowed.`,
        isError: true,
      };
    }
    // "localhost" always maps to loopback
    if (hostname === "localhost") {
      return {
        content: `Access to private network addresses is not allowed.`,
        isError: true,
      };
    }
    // Resolve DNS and check all IPs
    const [ipv4s, ipv6s] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ]);
    const allIps = [...ipv4s, ...ipv6s];
    if (allIps.some(isPrivateIp)) {
      return {
        content: `Access to private network addresses is not allowed.`,
        isError: true,
      };
    }
  } catch {
    // If DNS resolution fails entirely, let fetch handle it
  }

  // Fetch
  const maxChars = config.maxChars ?? 50000;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PinchyBot/1.0" },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        content: `HTTP error ${res.status}: ${res.statusText}`,
        isError: true,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();

    // Extract readable content
    let extracted: string;
    if (contentType.includes("text/html")) {
      const { document } = parseHTML(text);
      const reader = new Readability(document);
      const article = reader.parse();
      extracted = article?.textContent ?? text;
    } else {
      extracted = text;
    }

    if (extracted.length > maxChars) {
      extracted = extracted.slice(0, maxChars) + "\n\n[truncated]";
    }

    return { content: extracted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Failed to fetch URL: ${message}`, isError: true };
  }
}
