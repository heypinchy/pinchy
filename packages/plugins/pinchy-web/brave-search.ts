import { domainDenialReason } from "./web-fetch.js";

// External API call — bounds a hung Brave endpoint / network blackhole.
// Matches web-fetch.ts's external-call timeout.
const FETCH_TIMEOUT_MS = 30_000;

// Tracks whether we've already warned about a mock-override env var set
// without its paired insecure-mock flag, so a leftover override doesn't spam
// the log on every tool call.
let warnedAboutBraveBaseUrlOverride = false;

// Returns BRAVE_API_BASE_URL, but ONLY when PINCHY_INSECURE_WEB_MOCK is
// explicitly "1". BRAVE_API_BASE_URL lets E2E tests redirect Brave Search
// calls to a local mock server instead of https://api.search.brave.com.
// Without the flag, the override is ignored (the real API host is used) and
// a one-time warning is logged — same seam and same reasoning as the mail
// adapters' PINCHY_INSECURE_MAIL_MOCK (see resolveInsecureMockBaseUrl in
// pinchy-email/email-adapter.ts): a *_API_BASE_URL carried into production
// by accident must not silently redirect the Brave API key to whatever host
// it names.
function resolveBraveBaseUrl(): string {
  const override = process.env.BRAVE_API_BASE_URL;
  if (!override) return "https://api.search.brave.com";
  if (process.env.PINCHY_INSECURE_WEB_MOCK === "1") return override;
  if (!warnedAboutBraveBaseUrlOverride) {
    warnedAboutBraveBaseUrlOverride = true;
    console.warn(
      '[pinchy-web] BRAVE_API_BASE_URL is set but PINCHY_INSECURE_WEB_MOCK is not "1" — ignoring ' +
        "it and using the real API host. If this is a test/mock stack, also set " +
        "PINCHY_INSECURE_WEB_MOCK=1."
    );
  }
  return "https://api.search.brave.com";
}

// Test-only: clears the warn-once dedupe so a test can assert the warning
// fires again after resetting env stubs.
export function resetBraveBaseUrlWarningForTest(): void {
  warnedAboutBraveBaseUrlOverride = false;
}

export interface BraveSearchConfig {
  apiKey: string;
  allowedDomains?: string[];
  excludedDomains?: string[];
  language?: string;
  country?: string;
  freshness?: string;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  extra_snippets?: string[];
}

/**
 * Carries the HTTP status Brave answered with, so the plugin's auth-error
 * classifier can read it instead of hunting for digits in the message
 * (#1077). Brave's 401 body is `{"code":"SUBSCRIPTION_TOKEN_INVALID"}` — it
 * contains no auth *word* at all, so the status is the only honest signal
 * that the key is stale.
 */
export class BraveSearchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BraveSearchError";
    this.status = status;
  }
}

export async function braveSearch(
  query: string,
  config: BraveSearchConfig
): Promise<{ results: BraveSearchResult[]; filteredCount?: number }> {
  if (!config.apiKey) {
    throw new Error(
      "Brave Search API key is required. Configure it in Pinchy integration settings."
    );
  }

  // Build query with domain filters. Domains are already validated at the
  // API layer (validatePinchyWebConfig), but defend in depth: refuse anything
  // that could break out of the `site:` operator syntax (whitespace, quotes,
  // parens, boolean keywords) before concatenating into the query string.
  const assertSiteSafe = (d: string) => {
    if (/[\s"'()]/.test(d)) {
      throw new Error(`Invalid domain for site filter: ${JSON.stringify(d)}`);
    }
  };
  let q = query;
  if (config.allowedDomains?.length) {
    config.allowedDomains.forEach(assertSiteSafe);
    const sites = config.allowedDomains.map((d) => `site:${d}`).join(" OR ");
    q = config.allowedDomains.length === 1 ? `${q} ${sites}` : `${q} (${sites})`;
  }
  if (config.excludedDomains?.length) {
    config.excludedDomains.forEach(assertSiteSafe);
    q += " " + config.excludedDomains.map((d) => `-site:${d}`).join(" ");
  }

  const params = new URLSearchParams({
    q,
    extra_snippets: "true",
    count: "5",
  });
  if (config.country) params.set("country", config.country);
  if (config.language) params.set("search_lang", config.language);
  if (config.freshness) params.set("freshness", config.freshness);

  const BRAVE_SEARCH_BASE_URL = resolveBraveBaseUrl();

  const res = await fetch(`${BRAVE_SEARCH_BASE_URL}/res/v1/web/search?${params}`, {
    headers: {
      "X-Subscription-Token": config.apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BraveSearchError(`Brave Search API error (${res.status}): ${text}`, res.status);
  }

  const data = await res.json();
  const rawResults: BraveSearchResult[] = (data.web?.results ?? []).map(
    (r: Record<string, unknown>) => ({
      title: r.title as string,
      url: r.url as string,
      description: r.description as string,
      extra_snippets: r.extra_snippets as string[] | undefined,
    })
  );

  // The `site:`/`-site:` operators concatenated into the query above are a
  // best-effort hint to Brave, not enforcement: the model controls the
  // free-text part of the query and can append its own site: operators, and
  // Brave's behavior with multiple competing site: groups in one query is
  // unspecified. So filter results by hostname here too, using the exact
  // same allow/exclude + subdomain semantics as pinchy_web_fetch, before
  // handing anything to the model.
  if (!config.allowedDomains?.length && !config.excludedDomains?.length) {
    return { results: rawResults };
  }

  let filteredCount = 0;
  const results = rawResults.filter((r) => {
    let parsed: URL;
    try {
      parsed = new URL(r.url);
    } catch {
      // Unparseable URL — can't verify it's in scope, so drop it.
      filteredCount++;
      return false;
    }
    // pinchy_web_fetch gates on the scheme before it gates on the hostname,
    // and a non-HTTP URL carries an empty hostname that no exclude list can
    // ever match — so an exclude-only config would wave `data:`/`javascript:`
    // through here while web_fetch refuses it. Ask the same question in both.
    if (!["http:", "https:"].includes(parsed.protocol)) {
      filteredCount++;
      return false;
    }
    if (domainDenialReason(parsed.hostname, config)) {
      filteredCount++;
      return false;
    }
    return true;
  });

  return { results, filteredCount: filteredCount || undefined };
}
