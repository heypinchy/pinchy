export async function probeBraveApiKey(
  apiKey: string
): Promise<{ success: true } | { success: false; reason: string }> {
  try {
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=ping&count=1", {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    });
    if (res.ok) return { success: true };
    if (res.status === 401 || res.status === 403) {
      return { success: false, reason: `Authentication failed (HTTP ${res.status})` };
    }
    return { success: false, reason: `Brave API returned HTTP ${res.status}` };
  } catch (err) {
    return { success: false, reason: err instanceof Error ? err.message : "Network error" };
  }
}
