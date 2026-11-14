// @vitest-environment node
/**
 * The plugin source and its node_modules ship in different images: Pinchy
 * syncs the source into the shared extensions volume, the openclaw image
 * brings odoo-node. During an upgrade the new source can run against the old
 * odoo-node, and odoo-node before 0.4.0 drops the `fetch` option and calls
 * the global fetch — unpinned and without a timeout. That must fail loudly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.doUnmock("odoo-node");
  vi.resetModules();
});

describe("pinOdooClient against an odoo-node that ignores `fetch`", () => {
  it("refuses to build the client rather than connect unpinned", async () => {
    vi.resetModules();
    vi.doMock("odoo-node", () => ({
      // odoo-node 0.3.x: keeps url, db, uid and apiKey, nothing else.
      OdooClient: class {
        constructor(public config: { url: string }) {}
      },
    }));
    const { pinOdooClient } = await import("../pinned-fetch");

    expect(() =>
      pinOdooClient({ url: "https://odoo.example.test", db: "db", uid: 2, apiKey: "k" }, [
        { address: "127.0.0.1", family: 4 },
      ])
    ).toThrow(/odoo-node 0\.4\.0/);
  });
});
