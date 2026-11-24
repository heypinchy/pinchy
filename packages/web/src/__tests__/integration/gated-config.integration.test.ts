// Real-DB tests for `hasGatedConfig` — whether the "Remove all license-gated
// configuration" escape hatch applies. Every new shared agent is stored as
// `restricted`, so on a community instance that row is the default, not a
// restriction anyone configured (#1278). Counting it there showed a never-
// licensed admin a box claiming their restrictions "stay enforced".
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { agents, groups } from "@/db/schema";
import { hasGatedConfig } from "@/lib/gated-config";

async function seedSharedAgent(visibility: "all" | "restricted") {
  await db.insert(agents).values({
    name: "Shared",
    model: "anthropic/claude-haiku-5-5",
    greetingMessage: "Hi",
    visibility,
  });
}

describe("hasGatedConfig", () => {
  it("counts a restricted shared agent after a license ended", async () => {
    await seedSharedAgent("restricted");
    expect(await hasGatedConfig("expired")).toBe(true);
    expect(await hasGatedConfig("trial-expired")).toBe(true);
  });

  it("does not count the restricted default on a community instance", async () => {
    await seedSharedAgent("restricted");
    expect(await hasGatedConfig("community")).toBe(false);
  });

  it("counts groups in every inactive state", async () => {
    await db.insert(groups).values({ name: "HR" });
    expect(await hasGatedConfig("community")).toBe(true);
    expect(await hasGatedConfig("expired")).toBe(true);
  });

  it("is false with nothing gated", async () => {
    await seedSharedAgent("all");
    expect(await hasGatedConfig("expired")).toBe(false);
  });
});
