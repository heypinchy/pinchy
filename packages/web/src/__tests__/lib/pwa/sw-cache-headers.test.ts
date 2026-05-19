import { describe, it, expect } from "vitest";
import nextConfig from "../../../../next.config";

describe("next.config.ts /sw.js cache headers", () => {
  it("sets no-cache for /sw.js so SW updates propagate", async () => {
    expect(nextConfig.headers, "next.config must export headers()").toBeDefined();
    const headers = await nextConfig.headers!();
    const swRule = headers.find((r) => r.source === "/sw.js");
    expect(swRule, "no rule found for /sw.js").toBeDefined();
    const cacheControl = swRule!.headers.find((h) => h.key === "Cache-Control");
    expect(cacheControl?.value).toMatch(/no-cache/);
  });
});
