/**
 * Probe the Brave Search API with a candidate subscription key.
 *
 * Returns user-actionable error messages rather than raw HTTP codes — the
 * scenarios users actually hit when entering credentials are: wrong key,
 * rate limit, transient Brave outage, or no network.
 *
 * HTTP status mapping (observed in practice):
 *  - 401 / 403:  missing or invalid subscription key
 *  - 422:        Brave's typical response for a structurally valid but
 *                rejected subscription key (e.g. expired plan)
 *  - 429:        rate limit hit
 *  - 5xx:        Brave-side outage
 */
export async function probeBraveApiKey(
  apiKey: string
): Promise<{ success: true } | { success: false; reason: string }> {
  try {
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=ping&count=1", {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    });
    if (res.ok) return { success: true };

    if (res.status === 401 || res.status === 403 || res.status === 422) {
      return {
        success: false,
        reason:
          "The API key was rejected by Brave Search. Please verify the key is correct and your subscription is active.",
      };
    }

    if (res.status === 429) {
      return {
        success: false,
        reason: "Rate limit reached on Brave Search. Wait a moment and try again.",
      };
    }

    if (res.status >= 500) {
      return {
        success: false,
        reason: `Brave Search is temporarily unreachable (HTTP ${res.status}). Please try again in a moment.`,
      };
    }

    // Unexpected client-side status — surface the code so a caller can debug.
    return {
      success: false,
      reason: `Unexpected response from Brave Search (HTTP ${res.status}).`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    return {
      success: false,
      reason: `Could not reach Brave Search — network or DNS error. (${detail})`,
    };
  }
}
