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

export async function braveSearch(
  query: string,
  config: BraveSearchConfig,
): Promise<{ results: BraveSearchResult[] }> {
  if (!config.apiKey) {
    throw new Error(
      "Brave Search API key is required. Configure it in Pinchy integration settings.",
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
    q =
      config.allowedDomains.length === 1 ? `${q} ${sites}` : `${q} (${sites})`;
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

  const BRAVE_SEARCH_BASE_URL =
    process.env.BRAVE_API_BASE_URL ?? "https://api.search.brave.com";

  const res = await fetch(
    `${BRAVE_SEARCH_BASE_URL}/res/v1/web/search?${params}`,
    {
      headers: {
        "X-Subscription-Token": config.apiKey,
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brave Search API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const results = (data.web?.results ?? []).map((r: Record<string, unknown>) => ({
    title: r.title as string,
    url: r.url as string,
    description: r.description as string,
    extra_snippets: r.extra_snippets as string[] | undefined,
  }));

  return { results };
}
