import { describe, expect, it } from "vitest";

import { describeUnavailableFolders } from "@/lib/knowledge/unavailable-folders";

// The admin reads this on the Knowledge Base tab after a reindex that could
// not read any of the agent's folders (#1363). "None of the granted folders
// could be read" sent them hunting; naming the folders, and what is wrong with
// each, tells them which grant to fix and how.
describe("describeUnavailableFolders", () => {
  it("names a folder that is gone and says how to fix the grant", () => {
    const text = describeUnavailableFolders([{ path: "/data/old-suppliers", reason: "missing" }]);

    expect(text).toContain("/data/old-suppliers");
    expect(text).toMatch(/not found/i);
    expect(text).toMatch(/Allowed Directories/);
    expect(text).toMatch(/left as it was/);
  });

  // Removing the grant would be the wrong fix for a share mounted with the
  // wrong owner, so the two answers must not read the same.
  it("tells a folder Pinchy can't open apart from one that is gone", () => {
    const text = describeUnavailableFolders([
      { path: "/data/old-suppliers", reason: "missing" },
      { path: "/data/hr", reason: "unreadable" },
    ]);

    expect(text).toMatch(/not found: \/data\/old-suppliers/i);
    expect(text).toMatch(/can't open \/data\/hr/);
    expect(text).toMatch(/permissions/);
  });

  it("says a folder that came up empty still has its documents in the index", () => {
    const text = describeUnavailableFolders([{ path: "/data/share", reason: "emptied" }]);

    expect(text).toContain("/data/share");
    expect(text).toMatch(/empty/);
    expect(text).toMatch(/mounted/);
  });

  it("names the first few folders of a group and counts the rest", () => {
    const text = describeUnavailableFolders(
      ["a", "b", "c", "d", "e"].map((name) => ({ path: `/data/${name}`, reason: "missing" }))
    );

    expect(text).toContain("/data/a, /data/b, /data/c and 2 more");
    expect(text).not.toContain("/data/d");
  });

  // The text is stored through safeProviderError, which cuts at 1 KiB. A cut
  // mid-sentence would drop the advice the message exists to give.
  it("stays under 1 KiB however many and however long the paths are", () => {
    const long = (n: number) => `/data/${"x".repeat(400)}-${n}`;
    const text = describeUnavailableFolders([
      ...[1, 2, 3, 4].map((n) => ({ path: long(n), reason: "missing" as const })),
      ...[5, 6, 7, 8].map((n) => ({ path: long(n), reason: "unreadable" as const })),
      ...[9, 10, 11, 12].map((n) => ({ path: long(n), reason: "emptied" as const })),
    ]);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1024);
    expect(text).toMatch(/mounted\.$/);
  });

  // A folder name is whatever someone typed on a file server. A line break in
  // it must not be able to forge a second line of advice.
  it("keeps a path on one line", () => {
    const text = describeUnavailableFolders([
      { path: "/data/a\nCheck nothing.", reason: "missing" },
    ]);

    expect(text).not.toContain("\n");
  });
});
