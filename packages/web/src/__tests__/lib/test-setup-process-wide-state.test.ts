// The regenerate queue and the model caches a regenerate reads live on
// globalThis (see process-wide-cache.ts and regenerate-queue.ts), so a test
// file's `vi.resetModules()` no longer resets them: a fresh module instance
// finds the previous test's in-flight run and stale cache waiting for it. The
// shared setup file (src/test-setup.ts) resets both after every test, so no
// test can inherit either from the one before.
//
// The two tests below run in order: the first leaves both behind on purpose,
// the second asserts it did not inherit them.
import { describe, it, expect } from "vitest";
import { isMap, processWideCache } from "@/lib/process-wide-cache";
import { serializeRegenerates } from "@/lib/openclaw-config/regenerate-queue";

const KEY = "__pinchyTestSetupIsolationProbe" as const;

describe("process-wide state does not leak from one test into the next", () => {
  it("leaves a populated cache and a regenerate run in flight behind", () => {
    processWideCache(KEY, () => new Map<string, string>(), isMap).set("stale", "value");
    // A run that never settles — what a test failing mid-regenerate leaves.
    void serializeRegenerates(() => new Promise<void>(() => {}))();

    expect(processWideCache(KEY, () => new Map<string, string>(), isMap).get("stale")).toBe(
      "value"
    );
    expect(globalThis.__pinchyRegenerateQueue?.running).not.toBeNull();
  });

  it("starts the next test with an empty cache and an idle queue", async () => {
    expect(processWideCache(KEY, () => new Map<string, string>(), isMap).size).toBe(0);
    expect(globalThis.__pinchyRegenerateQueue?.running ?? null).toBeNull();

    // And a regenerate started now really runs, instead of queueing behind
    // the abandoned one forever.
    let ran = false;
    await serializeRegenerates(async () => {
      ran = true;
    })();
    expect(ran).toBe(true);
  });
});
