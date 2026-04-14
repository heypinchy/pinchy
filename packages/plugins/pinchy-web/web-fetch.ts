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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

async function isPrivateHostname(hostname: string): Promise<boolean> {
  if (isPrivateIp(hostname)) return true;
  if (hostname === "localhost") return true;
  const [ipv4s, ipv6s] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);
  return [...ipv4s, ...ipv6s].some(isPrivateIp);
}

function checkDomainAllowed(
  hostname: string,
  config: Pick<WebFetchConfig, "allowedDomains" | "excludedDomains">,
): string | null {
  if (config.allowedDomains?.length) {
    const allowed = config.allowedDomains.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (!allowed) {
      return `This agent is not allowed to fetch content from ${hostname}. Allowed domains: ${config.allowedDomains.join(", ")}`;
    }
  }
  if (config.excludedDomains?.length) {
    const excluded = config.excludedDomains.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (excluded) {
      return `Domain ${hostname} is blocked for this agent.`;
    }
  }
  return null;
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
  const domainError = checkDomainAllowed(hostname, config);
  if (domainError) {
    return { content: domainError, isError: true };
  }

  // SSRF guard — resolve hostname and check IPs
  try {
    if (await isPrivateHostname(hostname)) {
      return {
        content: `Access to private network addresses is not allowed.`,
        isError: true,
      };
    }
  } catch {
    // If DNS resolution fails entirely, let fetch handle it
  }

  // Fetch with manual redirect handling to prevent SSRF via redirect
  const maxChars = config.maxChars ?? 50000;
  try {
    let currentUrl = url;
    let res: Response | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      res = await fetch(currentUrl, {
        headers: { "User-Agent": "PinchyBot/1.0" },
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
      });

      if (!REDIRECT_STATUSES.has(res.status)) break;

      const location = res.headers.get("location");
      if (!location) break;

      // Resolve relative redirects
      const redirectUrl = new URL(location, currentUrl);
      if (!["http:", "https:"].includes(redirectUrl.protocol)) {
        return { content: `Redirect to unsupported protocol.`, isError: true };
      }

      // SSRF check on redirect target
      if (await isPrivateHostname(redirectUrl.hostname)) {
        return {
          content: `Access to private network addresses is not allowed.`,
          isError: true,
        };
      }

      // Domain filtering on redirect target
      const redirectDomainError = checkDomainAllowed(redirectUrl.hostname, config);
      if (redirectDomainError) {
        return { content: redirectDomainError, isError: true };
      }

      if (i === MAX_REDIRECTS) {
        return { content: `Too many redirects.`, isError: true };
      }

      currentUrl = redirectUrl.href;
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      const statusText = res?.statusText ?? "Unknown";
      return {
        content: `HTTP error ${status}: ${statusText}`,
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
