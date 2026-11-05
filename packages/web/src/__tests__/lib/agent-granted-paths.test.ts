import { describe, it, expect } from "vitest";

import { grantedDataPaths, ungrantablePaths } from "@/lib/agent-granted-paths";

// Since v0.9.1 every writer of `pinchy-files.allowed_paths` confines it to
// /data (pluginConfigSchema). Rows written before that can still carry other
// folders (#1272); these two functions are how every reader tells them apart.
describe("grantedDataPaths", () => {
  it("returns only the entries under /data, in their stored order", () => {
    expect(
      grantedDataPaths({
        "pinchy-files": {
          allowed_paths: ["/data/b", "/root/.openclaw/workspaces", "/data/a", "relative/data"],
        },
      })
    ).toEqual(["/data/b", "/data/a"]);
  });

  it("returns an empty list for a missing config", () => {
    expect(grantedDataPaths(null)).toEqual([]);
    expect(grantedDataPaths({})).toEqual([]);
    expect(grantedDataPaths({ "pinchy-files": {} as never })).toEqual([]);
  });

  it("tolerates a non-array value instead of throwing", () => {
    // jsonb is not checked against the type; a malformed pre-lockdown row must
    // read as "nothing granted", not take the config build down.
    expect(grantedDataPaths({ "pinchy-files": { allowed_paths: "/" as never } })).toEqual([]);
  });
});

describe("ungrantablePaths", () => {
  it("returns exactly the entries grantedDataPaths drops", () => {
    expect(
      ungrantablePaths({
        "pinchy-files": {
          allowed_paths: ["/data/kb", "/root/.openclaw/workspaces", "/", "/database"],
        },
      })
    ).toEqual(["/root/.openclaw/workspaces", "/", "/database"]);
  });

  it("returns an empty list when every entry is under /data", () => {
    expect(ungrantablePaths({ "pinchy-files": { allowed_paths: ["/data/kb"] } })).toEqual([]);
    expect(ungrantablePaths(null)).toEqual([]);
  });
});
