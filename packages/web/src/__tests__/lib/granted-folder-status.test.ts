import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkGrantedFolders } from "@/lib/granted-folder-status";

// The real data root is `/data/`, which does not exist on a developer machine,
// so the module takes the root as a parameter, like listDataSubdirectories.
let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "pinchy-grant-status-")));
  root = join(sandbox, "data");
  outside = join(sandbox, "secrets");
  await mkdir(join(root, "suppliers", "food"), { recursive: true });
  await writeFile(join(root, "suppliers", "price-list.pdf"), "x");
  await mkdir(join(outside, "keys"), { recursive: true });
});

afterEach(async () => {
  await chmod(join(root, "suppliers"), 0o755).catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
});

describe("checkGrantedFolders", () => {
  it("reports a folder that exists and opens as available", async () => {
    expect(
      await checkGrantedFolders([join(root, "suppliers"), join(root, "suppliers/food/")], { root })
    ).toEqual([
      { path: join(root, "suppliers"), status: "available" },
      { path: join(root, "suppliers/food/"), status: "available" },
    ]);
  });

  it("reports a folder that is gone as missing (#1363)", async () => {
    expect(await checkGrantedFolders([join(root, "pinchy-suppliers")], { root })).toEqual([
      { path: join(root, "pinchy-suppliers"), status: "missing" },
    ]);
    expect(
      await checkGrantedFolders([join(root, "suppliers", "gone", "deeper")], { root })
    ).toEqual([{ path: join(root, "suppliers", "gone", "deeper"), status: "missing" }]);
  });

  it("reports a file where a folder was granted as missing", async () => {
    expect(
      await checkGrantedFolders([join(root, "suppliers", "price-list.pdf")], { root })
    ).toEqual([{ path: join(root, "suppliers", "price-list.pdf"), status: "missing" }]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "tells a folder Pinchy cannot open apart from one that is gone",
    async () => {
      await chmod(join(root, "suppliers"), 0o000);
      const [food, suppliers] = await checkGrantedFolders(
        [join(root, "suppliers", "food"), join(root, "suppliers")],
        { root }
      );
      expect(suppliers.status).toBe("unreadable");
      // A folder below one Pinchy cannot open cannot be checked either; it is
      // not reported as gone, because nobody knows that it is.
      expect(food.status).toBe("unreadable");
    }
  );

  it("reports a symlink as a link without following it out of the root", async () => {
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "nowhere"), join(root, "dangling"));
    expect(
      await checkGrantedFolders(
        [join(root, "escape"), join(root, "escape", "keys"), join(root, "dangling")],
        { root }
      )
    ).toEqual([
      { path: join(root, "escape"), status: "link" },
      { path: join(root, "escape", "keys"), status: "link" },
      // A dangling link outside the root answers exactly like a working one:
      // the check never looks at where a link points, so it cannot be used to
      // learn whether something exists out there.
      { path: join(root, "dangling"), status: "link" },
    ]);
  });

  it("never touches a path outside the root, however it is spelled", async () => {
    expect(
      await checkGrantedFolders(
        [outside, join(root, "..", "secrets"), root + "base", "relative/path"],
        { root }
      )
    ).toEqual([
      { path: outside, status: "outside_data" },
      { path: join(root, "..", "secrets"), status: "outside_data" },
      { path: root + "base", status: "outside_data" },
      { path: "relative/path", status: "outside_data" },
    ]);
  });

  it("accepts a grant of the whole data root, as isPathUnderDataRoot does", async () => {
    expect(await checkGrantedFolders([root, root + "/"], { root })).toEqual([
      { path: root, status: "available" },
      { path: root + "/", status: "available" },
    ]);
  });
});
